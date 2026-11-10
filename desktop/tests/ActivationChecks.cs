using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using LeeT.Desktop;

internal static class ActivationChecks
{
    private static readonly object Status = new { schema = 1, action = "status" };
    internal static async Task Run()
    {
        var root = Environment.GetEnvironmentVariable("LEET_ACTIVATION_TEST_ROOT") ?? throw new Exception("Activation fixture required.");
        var source = Environment.GetEnvironmentVariable("LEET_ACTIVATION_TEST_SOURCE") ?? throw new Exception("Activation source required.");
        var node = Environment.GetEnvironmentVariable("LEET_ACTIVATION_TEST_NODE") ?? throw new Exception("Activation Node required.");
        var config = Path.Combine(root, "payload", "desktop", "activation.private.json");
        var script = Path.Combine(source, "desktop", "tests", "activation-fixture.mjs");
        var bridge = new ActivationBridge(node, script, config, TimeSpan.FromSeconds(15));
        var files = new Files();
        var ui = new ActivationWindow(bridge, files, offlineOnly: true);
        ui.Show();
        try
        {
            await Until(() => !ui.Busy && ui.Status.StartsWith("Ready to activate"));
            Require(!ui.Continue.IsEnabled && !ui.Online.IsEnabled, "Activation must not continue without verification.");
            Require(!ui.Code.IsVisible && !ui.Online.IsVisible && !ui.Status.Contains("purchase key"),
                "Offline activation must only show device requests and signed licenses.");
            ui.UpdateLayout();
            Require(ui.Continue.TranslatePoint(new Point(0,ui.Continue.ActualHeight),ui).Y <= ui.ActualHeight - 8,
                "The initial activation footer is clipped on the default screen.");
            Save(ui, Path.Combine(root, "activation-ready.png"));
            Click(ui.Export); // Cancelled native file dialog must not create an installation identity.
            Require(!File.Exists(Path.Combine(root, "license", "installation-id")), "Cancelled export created an identity.");
            files.Save = Path.Combine(root, "device-request.json"); Click(ui.Export);
            await Until(() => !ui.Busy && File.Exists(files.Save));
            var request = await File.ReadAllTextAsync(files.Save);
            Click(ui.Export); await Until(() => !ui.Busy);
            Require(await File.ReadAllTextAsync(files.Save) == request, "Export changed the installation identity.");
            files.Open = Path.Combine(root, "broken.json"); await File.WriteAllTextAsync(files.Open, "{broken");
            Click(ui.Import); await Until(() => !ui.Busy);
            Require(!ui.Continue.IsEnabled && ui.Status.StartsWith("Activation could not"), "Malformed import was accepted.");
            await File.WriteAllTextAsync(files.Open, new string('界',6000)); Click(ui.Import); await Until(() => !ui.Busy);
            Require(!ui.Continue.IsEnabled && !File.Exists(Path.Combine(root,"license","license.json")), "Oversized UTF8 import was accepted.");
            await RunNode(node, Path.Combine(source, "desktop", "tests", "prepare-activation-fixture.mjs"), root, "sign", files.Save);
            files.Open = Path.Combine(root, "license-to-import.json"); Click(ui.Import);
            await Until(() => !ui.Busy && ui.Continue.IsEnabled);
            Require(!ui.Online.IsEnabled && !ui.Export.IsEnabled && !ui.Import.IsEnabled, "Verified activation must lock mutation controls.");
            Save(ui, Path.Combine(root, "activation-success.png"));
            Click(ui.Continue); Require(ui.ActivationAccepted, "Verified Continue did not accept activation.");
        }
        finally { ui.Close(); }

        var installed = ActivationBridge.Installed(Path.GetDirectoryName(config)!);
        ActivationBridge.RequireProtectedFile(Path.Combine(root,"payload","app","src","commercial","license.mjs"));
        Require(!installed.CanExportRequestTo(config) && !installed.CanExportRequestTo(Path.Combine(root,"license","license.json")) &&
            installed.CanExportRequestTo(Path.Combine(root,"device-request.json")), "Request export could overwrite installation files.");
        Require((await installed.Send(Status, CancellationToken.None)).GetProperty("state").GetString() == "activation-required",
            "A different hardware identity must not accept the fixture license.");
        // The fixed entry rejects writable configuration before starting a child.
        var info = new FileInfo(config); var originalAcl = info.GetAccessControl(); var insecure = info.GetAccessControl();
        insecure.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-32-545"), FileSystemRights.Write, AccessControlType.Allow));
        info.SetAccessControl(insecure);
        try { ExpectFailure(() => ActivationBridge.Installed(Path.GetDirectoryName(config)!)); }
        finally
        {
            var restored = new FileSecurity();
            restored.SetSecurityDescriptorBinaryForm(originalAcl.GetSecurityDescriptorBinaryForm(), AccessControlSections.Access);
            info.SetAccessControl(restored);
        }
        ActivationBridge.Installed(Path.GetDirectoryName(config)!);

        var onlineConfig = await Config(config, "online", root);
        var previous = Environment.GetEnvironmentVariable("NODE_OPTIONS");
        var previousDatabase = Environment.GetEnvironmentVariable("PGPASSWORD");
        Environment.SetEnvironmentVariable("NODE_OPTIONS", "--require nonexistent-secret-module");
        Environment.SetEnvironmentVariable("PGPASSWORD", "must-not-reach-child");
        var online = new ActivationWindow(new ActivationBridge(node, script, onlineConfig, TimeSpan.FromSeconds(15)), files);
        online.Show();
        try
        {
            await Until(() => !online.Busy && online.Status.StartsWith("Ready to activate"));
            online.Code.Password = string.Concat("LT-", new string('b', 32)); Click(online.Online);
            Require(online.Busy && !online.Export.IsEnabled && !online.Continue.IsEnabled, "Busy controls were not locked.");
            await Until(() => !online.Busy);
            Require(online.Code.Password == "" && !online.Continue.IsEnabled, "Failed activation retained the key or unlocked Continue.");
            online.Code.Password = string.Concat("LT-", new string('a', 32)); Click(online.Online);
            await Until(() => !online.Busy && online.Continue.IsEnabled);
            Require(online.Code.Password == "", "Successful activation retained the key.");
        }
        finally
        {
            online.Close(); Environment.SetEnvironmentVariable("NODE_OPTIONS", previous); Environment.SetEnvironmentVariable("PGPASSWORD", previousDatabase);
        }
        foreach (var mode in new[] { "oversize", "invalid-utf8", "bad-exit" })
        {
            var bad = new ActivationBridge(node, script, await Config(config, mode, root), TimeSpan.FromSeconds(5));
            await ExpectFailure(() => bad.Send(Status, CancellationToken.None));
        }
        var hang = await Config(config, "hang", root);
        var hanging = new ActivationBridge(node, script, hang, TimeSpan.FromSeconds(1));
        await ExpectFailure(() => hanging.Send(Status, CancellationToken.None));
        var pidFile = Path.Combine(root, "hanging-pid");
        var pid = int.Parse(await File.ReadAllTextAsync(pidFile));
        Require(Exited(pid), "Timed-out helper survived.");
        Require(Exited(int.Parse(await File.ReadAllTextAsync(Path.Combine(root,"hanging-child-pid")))), "Timed-out helper descendant survived.");
        File.Delete(pidFile);
        var cancelled = new ActivationBridge(node, script, hang, TimeSpan.FromSeconds(15));
        using var cancel = new CancellationTokenSource();
        var pending = cancelled.Send(Status, cancel.Token);
        await Pid(pidFile);
        await ExpectFailure(() => cancelled.Send(Status, CancellationToken.None)); // No overlapping helper process.
        cancel.Cancel(); await ExpectFailure(() => pending);
        pid = await Pid(pidFile); Require(Exited(pid), "Cancelled helper survived.");
        Require(Exited(int.Parse(await File.ReadAllTextAsync(Path.Combine(root,"hanging-child-pid")))), "Cancelled helper descendant survived.");
        File.Delete(pidFile);
        var closing = new ActivationWindow(new ActivationBridge(node,script,hang,TimeSpan.FromSeconds(15)),files);
        closing.Show(); pid = await Pid(pidFile); closing.Close(); await Until(() => !closing.Busy);
        Require(Exited(pid) && !closing.ActivationAccepted,"Closing the activation window left a helper or accepted setup.");
        Require(Exited(int.Parse(await File.ReadAllTextAsync(Path.Combine(root,"hanging-child-pid")))), "Window close left a helper descendant.");
        var falseSuccess = new ActivationWindow(new FalseSuccess()); falseSuccess.Show();
        try
        {
            await Until(() => !falseSuccess.Busy && falseSuccess.Status.StartsWith("Ready to activate"));
            falseSuccess.Code.Password = string.Concat("LT-", new string('a', 32)); Click(falseSuccess.Online);
            await Until(() => !falseSuccess.Busy);
            Require(!falseSuccess.Continue.IsEnabled && !falseSuccess.ActivationAccepted, "Unverified helper success unlocked setup.");
        }
        finally { falseSuccess.Close(); }
        Console.WriteLine("Native activation UI: offline export/import and online signing, status verification, malformed-license refusal, fixed protected configuration, isolated child environment, bounded output, timeout/cancellation cleanup and busy controls passed.");
    }

    private static async Task<string> Config(string source, string mode, string root)
    {
        using var data = JsonDocument.Parse(await File.ReadAllTextAsync(source));
        var values = data.RootElement.GetProperty("Environment").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString());
        values["LEE_T_LICENSE_DIR"] = Path.Combine(root, mode + "-license");
        var target = Path.Combine(Path.GetDirectoryName(source)!, mode + ".config.json");
        await File.WriteAllTextAsync(target, JsonSerializer.Serialize(new { Environment = values }));
        return target;
    }
    private static async Task RunNode(string node, params string[] args)
    {
        var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        start.Environment.Remove("NODE_OPTIONS");
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15)); await Task.WhenAll(output, errors);
        Require(process.ExitCode == 0, "Offline fixture signing failed.");
    }
    private static bool Exited(int pid) { try { using var process = Process.GetProcessById(pid); return process.HasExited; } catch (ArgumentException) { return true; } }
    private static async Task<int> Pid(string file)
    {
        var pid = 0;
        await Until(() => { try { return int.TryParse(File.ReadAllText(file), out pid); } catch (IOException) { return false; } });
        return pid;
    }
    private static void Click(Button button) => button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    private static void Save(Window window, string file)
    {
        window.UpdateLayout();
        var bitmap = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(window); var png = new PngBitmapEncoder(); png.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = File.Create(file); png.Save(stream);
    }
    private static void Require(bool valid, string message) { if (!valid) throw new InvalidOperationException(message); }
    private static void ExpectFailure(Action action) { try { action(); } catch { return; } throw new Exception("Unsafe operation was accepted."); }
    private static async Task ExpectFailure(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Unsafe operation was accepted."); }
    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (!condition()) { if (DateTime.UtcNow >= deadline) throw new TimeoutException("Activation UI condition timed out."); await Task.Delay(50); }
    }
    private sealed class Files : IActivationFiles
    {
        internal string? Save, Open;
        public string? SaveRequest(Window owner) => Save;
        public string? OpenLicense(Window owner) => Open;
    }
    private sealed class FalseSuccess : IActivationBridge
    {
        public Task<JsonElement> Send(object input, CancellationToken cancellation)
        {
            using var command = JsonDocument.Parse(JsonSerializer.Serialize(input));
            var status = command.RootElement.GetProperty("action").GetString() == "status";
            return Task.FromResult(JsonSerializer.SerializeToElement(new { schema = 1, ok = true, state = status ? "activation-required" : "activated" }));
        }
    }
}
