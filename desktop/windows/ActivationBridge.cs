using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace LeeT.Desktop;

internal interface IActivationBridge
{
    Task<JsonElement> Send(object input, CancellationToken cancellation);
    bool CanExportRequestTo(string path) => true;
}

internal sealed class ActivationBridge(string node, string script, string configuration, TimeSpan timeout) : IActivationBridge
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string[] exportBlocked = [];
    internal static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static ActivationBridge Installed(string desktopDirectory)
    {
        if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            throw new InvalidOperationException("SETUP_REQUIRED");
        var root = Path.GetFullPath(Path.Combine(desktopDirectory, ".."));
        var config = Path.Combine(desktopDirectory, "activation.private.json");
        var node = Path.Combine(root, "runtime", "node.exe");
        var script = Path.Combine(root, "app", "scripts", "desktop-activation.mjs");
        foreach (var path in new[] { config, node, script }) RequireProtectedFile(path);
        using var document = JsonDocument.Parse(File.ReadAllText(config, StrictUtf8));
        var values = document.RootElement.GetProperty("Environment");
        var allowed = new[] { "LEE_T_LICENSE_DIR", "LEE_T_ISSUER_PUBLIC_KEY_PATH", "LEE_T_ISSUER_KEY_ID", "LEE_T_ACTIVATION_ENDPOINT" };
        if (values.ValueKind != JsonValueKind.Object || values.EnumerateObject().Any(p =>
            !allowed.Contains(p.Name) || p.Value.ValueKind != JsonValueKind.String)) throw new InvalidOperationException("SETUP_REQUIRED");
        if (!Path.IsPathFullyQualified(values.GetProperty("LEE_T_LICENSE_DIR").GetString()!)) throw new InvalidOperationException("SETUP_REQUIRED");
        RequireProtectedFile(values.GetProperty("LEE_T_ISSUER_PUBLIC_KEY_PATH").GetString()!);
        if (string.IsNullOrWhiteSpace(values.GetProperty("LEE_T_ISSUER_KEY_ID").GetString())) throw new InvalidOperationException("SETUP_REQUIRED");
        return new(node, script, config, TimeSpan.FromSeconds(60))
        {
            exportBlocked = [root, Path.GetFullPath(values.GetProperty("LEE_T_LICENSE_DIR").GetString()!)],
        };
    }

    public bool CanExportRequestTo(string path)
    {
        var target = Path.GetFullPath(path);
        return !exportBlocked.Any(root => target.Equals(root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
            target.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
    }

    internal static void RequireProtectedFile(string path)
    {
        var file = new FileInfo(path);
        if (!file.Exists || file.Length > (file.Extension == ".exe" ? 200_000_000 : 16384) ||
            (file.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("SETUP_REQUIRED");
        foreach (var acl in new FileSystemSecurity[] { file.GetAccessControl(), file.Directory!.GetAccessControl() })
        {
            var trusted = new[] { "S-1-5-18", "S-1-5-32-544" };
            if (acl.GetOwner(typeof(SecurityIdentifier)) is not { } owner || !trusted.Contains(owner.Value)) throw new InvalidOperationException("SETUP_REQUIRED");
            const FileSystemRights writes = FileSystemRights.Write | FileSystemRights.Delete |
                FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & writes) != 0 &&
                    !trusted.Contains(rule.IdentityReference.Value)) throw new InvalidOperationException("SETUP_REQUIRED");
        }
    }

    public async Task<JsonElement> Send(object input, CancellationToken cancellation)
    {
        if (!await gate.WaitAsync(0, cancellation)) throw new InvalidOperationException("BUSY");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(timeout);
        using var process = new Process();
        var started = false;
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(input);
            if (bytes.Length > 16384) throw new InvalidOperationException("INVALID_REQUEST");
            var start = new ProcessStartInfo(node)
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(script)!,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            };
            start.ArgumentList.Add(script);
            start.Environment.Clear();
            foreach (var name in new[] { "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432" })
                if (Environment.GetEnvironmentVariable(name) is { } value) start.Environment[name] = value;
            start.Environment["PATH"] = Environment.SystemDirectory;
            start.Environment["WAREHOUSE_CONFIG_PATH"] = configuration;
            process.StartInfo = start;
            if (!process.Start()) throw new InvalidOperationException("ACTIVATION_FAILED");
            started = true;
            using var cancel = deadline.Token.Register(() => Stop(process));
            var output = ReadBounded(process.StandardOutput.BaseStream, 16384, deadline.Token, () => Stop(process));
            var errors = ReadBounded(process.StandardError.BaseStream, 4096, deadline.Token, () => Stop(process));
            var exit = process.WaitForExitAsync(deadline.Token);
            await process.StandardInput.BaseStream.WriteAsync(bytes, deadline.Token);
            process.StandardInput.Close();
            await Task.WhenAll(output, errors, exit);
            deadline.Token.ThrowIfCancellationRequested();
            if ((await errors).Length != 0) throw new InvalidOperationException("ACTIVATION_FAILED");
            using var response = JsonDocument.Parse(await output);
            var result = response.RootElement;
            if (result.GetProperty("schema").GetInt32() != 1 ||
                (process.ExitCode == 0) != result.GetProperty("ok").GetBoolean()) throw new InvalidOperationException("ACTIVATION_FAILED");
            return result.Clone();
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
        catch { throw new InvalidOperationException("ACTIVATION_FAILED"); }
        finally
        {
            if (started)
            {
                Stop(process);
                try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            }
            gate.Release();
        }
    }

    internal static async Task<string> ReadBounded(Stream stream, int limit, CancellationToken cancellation, Action? fail = null)
    {
        try
        {
            using var buffer = new MemoryStream();
            var bytes = new byte[1024];
            int size;
            while ((size = await stream.ReadAsync(bytes, cancellation)) != 0)
            {
                if (buffer.Length + size > limit) throw new InvalidOperationException("INPUT_TOO_LARGE");
                buffer.Write(bytes, 0, size);
            }
            return StrictUtf8.GetString(buffer.ToArray());
        }
        catch { fail?.Invoke(); throw; }
    }

    private static void Stop(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
    }
}
