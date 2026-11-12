using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Web.Script.Serialization;

// Dedicated host: never reads a warehouse service configuration.
public sealed class LicenseCenterService : ServiceBase
{
    private Process child;
    private bool stopping;
    private readonly string root;
    private readonly string app;
    private readonly object gate = new object();
    public LicenseCenterService(string dataRoot)
    {
        ServiceName = "LeeTLicenseCenter";
        root = Path.GetFullPath(dataRoot);
        app = Path.GetDirectoryName(typeof(LicenseCenterService).Assembly.Location);
        CanStop = true;
    }
    private void Log(string text)
    {
        if (String.IsNullOrEmpty(text)) return;
        lock (gate)
        {
            string file = Path.Combine(root, "license-center-service.log");
            if (File.Exists(file) && new FileInfo(file).Length > 2097152)
            {
                if (File.Exists(file + ".previous")) File.Delete(file + ".previous");
                File.Move(file, file + ".previous");
            }
            File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + text + Environment.NewLine, Encoding.UTF8);
        }
    }
    protected override void OnStart(string[] args)
    {
        stopping = false;
        string config = Path.Combine(root, "management.private.json");
        if (!File.Exists(config)) throw new InvalidOperationException("Initialize License Center first.");
        ProcessStartInfo info = new ProcessStartInfo(Path.Combine(app, "runtime", "node.exe"),
            "\"" + Path.Combine(app, "app", "scripts", "start-license-management.mjs") + "\"");
        info.WorkingDirectory = Path.Combine(app, "app");
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        foreach (string key in new [] { "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "OPENSSL_CONF" })
            info.EnvironmentVariables.Remove(key);
        info.EnvironmentVariables["LEE_T_MANAGEMENT_CONFIG"] = config;
        info.EnvironmentVariables["LEE_T_OFFLINE_ONLY"] = "1";
        child = new Process { StartInfo = info, EnableRaisingEvents = true };
        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
        child.Exited += delegate { if (!stopping) { Log("Backend stopped unexpectedly. Windows will restart the service."); Environment.Exit(1); } };
        if (!child.Start()) throw new InvalidOperationException("Could not start the issuer backend.");
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
        Log("Dedicated offline issuer started.");
    }
    protected override void OnStop()
    {
        stopping = true;
        RequestAdditionalTime(30000);
        if (child == null) return;
        if (!child.HasExited)
        {
            try { child.StandardInput.WriteLine("shutdown"); child.StandardInput.Close(); } catch (IOException) { }
            if (!child.WaitForExit(20000)) { child.Kill(); child.WaitForExit(5000); }
        }
        child.Dispose();
        Log("Dedicated offline issuer stopped.");
    }
    public static void Main(string[] args)
    {
        if (args.Length != 1) throw new ArgumentException("Issuer data directory required.");
        ServiceBase.Run(new LicenseCenterService(args[0]));
    }
}
