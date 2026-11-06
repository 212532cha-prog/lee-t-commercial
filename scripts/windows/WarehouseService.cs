using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ServiceProcess;
using System.Collections.Generic;
using System.Web.Script.Serialization;

public sealed class WarehouseService : ServiceBase
{
    private readonly string configPath;
    private Process child;
    private bool stopping;
    private string logPath;
    private readonly object logGate = new object();
    private readonly Dictionary<string, object> config;
    public WarehouseService(string path)
    {
        configPath = Path.GetFullPath(path);
        config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath, Encoding.UTF8));
        ServiceName = (string)config["ServiceName"];
        CanStop = true;
        AutoLog = true;
    }
    private void Log(string line)
    {
        if (String.IsNullOrEmpty(line)) return;
        lock (logGate)
        {
            if (File.Exists(logPath) && new FileInfo(logPath).Length > 2 * 1024 * 1024)
            {
                if (File.Exists(logPath + ".previous")) File.Delete(logPath + ".previous");
                File.Move(logPath, logPath + ".previous");
            }
            File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine, Encoding.UTF8);
        }
    }
    protected override void OnStart(string[] args)
    {
        stopping = false;
        string root = Path.GetFullPath((string)config["AppRoot"]);
        string node = Path.GetFullPath((string)config["NodePath"]);
        string entry = Path.GetFullPath(Path.Combine(root, config.ContainsKey("EntryScript") ? (string)config["EntryScript"] : "scripts/start-app.mjs"));
        if (!entry.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(entry) || !File.Exists(node)) throw new InvalidOperationException("Invalid application path.");
        Dictionary<string, object> environment = (Dictionary<string, object>)config["Environment"];
        string data = Path.GetFullPath((string)environment["DATA_DIR"]);
        Directory.CreateDirectory(data);
        logPath = Path.Combine(data, "warehouse-service.log");
        ProcessStartInfo info = new ProcessStartInfo(node, "\"" + entry + "\"");
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        foreach (KeyValuePair<string, object> item in environment) info.EnvironmentVariables[item.Key] = (string)item.Value;
        info.EnvironmentVariables["WAREHOUSE_CONFIG_PATH"] = configPath;
        child = new Process();
        child.StartInfo = info;
        child.EnableRaisingEvents = true;
        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
        child.Exited += delegate { if (!stopping) { Log("Child exited unexpectedly. Service recovery may restart it."); Environment.Exit(1); } };
        if (!child.Start()) throw new InvalidOperationException("Cannot start application.");
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
        Log("Service started.");
    }
    protected override void OnStop()
    {
        stopping = true;
        RequestAdditionalTime(60000);
        if (child == null) return;
        if (!child.HasExited)
        {
            try { child.StandardInput.WriteLine("shutdown"); child.StandardInput.Flush(); child.StandardInput.Close(); } catch (IOException) { }
            if (!child.WaitForExit(45000)) { Log("Forced stop after timeout. Interrupted work must be checked at next startup."); child.Kill(); child.WaitForExit(5000); }
        }
        child.Dispose();
        Log("Service stopped.");
    }
    public static void Main(string[] args)
    {
        if (args.Length != 1) throw new ArgumentException("Protected configuration file path required.");
        ServiceBase.Run(new WarehouseService(args[0]));
    }
}
