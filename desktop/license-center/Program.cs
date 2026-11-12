using System.IO;
using System.Text.Json;
using System.Windows;

namespace LeeT.LicenseCenter;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--test", var root, var passwordFile, var requestFile, var outputFile])
        {
            try
            {
                var testApp = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                var window = new LicenseWindow(root);
                if (window.Icon == null || window.Content == null)
                    throw new InvalidOperationException("The desktop window could not be initialized.");
                window.Close();
                RunTest(root, passwordFile, requestFile, outputFile).GetAwaiter().GetResult();
                testApp.Shutdown();
                return 0;
            }
            catch { return 1; }
        }

        var app = new Application();
        return app.Run(new LicenseWindow(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Lee T License Center")));
    }

    private static async Task RunTest(string root, string passwordFile, string requestFile, string outputFile)
    {
        await InstalledRuntime.EnsureReady(root);
        var password = File.ReadAllText(passwordFile);
        using var client = new IssuerClient(root, password);
        using var wrong = new IssuerClient(root, password + "x");
        try
        {
            await wrong.Customers();
            throw new InvalidOperationException("Invalid password accepted.");
        }
        catch (IssuerException error) when (error.Message == "OPERATOR_PASSWORD_REQUIRED") { }

        var request = IssuerClient.ReadRequest(requestFile);
        var customer = (await client.AddCustomer("Desktop integration fixture")).GetProperty("id").GetGuid();
        if (!(await client.Customers()).EnumerateArray().Any(row => row.GetProperty("id").GetGuid() == customer))
            throw new InvalidOperationException("Customer could not be selected.");
        var payment = (await client.AddPayment(customer, "desktop-" + Guid.NewGuid().ToString("N"), "initial", "0.8.5")).GetProperty("id").GetGuid();
        if (!(await client.Payments(customer)).EnumerateArray().Any(row => row.GetProperty("id").GetGuid() == payment))
            throw new InvalidOperationException("Payment could not be selected.");
        var first = await client.Sign(customer, payment, "", request);
        var retry = await client.Sign(customer, payment, "", request);
        if (first.GetProperty("signature").GetString() != retry.GetProperty("signature").GetString())
            throw new InvalidOperationException("Signing retry changed the license.");
        File.WriteAllText(outputFile, JsonSerializer.Serialize(first));
    }
}
