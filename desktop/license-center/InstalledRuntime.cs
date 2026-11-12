using System.Diagnostics;
using System.IO;
using System.Net.Sockets;

namespace LeeT.LicenseCenter;

internal static class InstalledRuntime
{
    internal static async Task EnsureReady(string root)
    {
        // Development fixtures continue to use their isolated, externally started backend.
        if (!File.Exists(Path.Combine(root, "installation.json"))) return;
        foreach (var name in new[] { "LeeTLicensePostgreSQL17", "LeeTLicenseCenter" })
        {
            var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "sc.exe"))
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            info.ArgumentList.Add("start");
            info.ArgumentList.Add(name);
            using var process = Process.Start(info) ?? throw new IssuerException("ISSUER_SERVICE_UNAVAILABLE");
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw new IssuerException("ISSUER_SERVICE_UNAVAILABLE"); }
            await Task.WhenAll(output, error);
            if (process.ExitCode is not (0 or 1056)) throw new IssuerException("ISSUER_SERVICE_UNAVAILABLE");
        }
        for (var attempt = 0; attempt < 100; attempt++)
        {
            using var socket = new TcpClient();
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                await socket.ConnectAsync("127.0.0.1", 8444, timeout.Token);
                return;
            }
            catch (Exception error) when (error is SocketException or OperationCanceledException) { }
            await Task.Delay(200);
        }
        throw new IssuerException("ISSUER_BACKEND_NOT_READY");
    }
}
