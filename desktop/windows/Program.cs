using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("LeeT.Desktop.Smoke")]

namespace LeeT.Desktop;

internal static class Program
{
    private static readonly Uri Warehouse = new("https://localhost:3443/");
    private static readonly HttpClient Server = new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
    {
        Timeout = TimeSpan.FromSeconds(2),
    };

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--check-runtime" }))
        {
            try { return string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString()) ? 1 : 0; }
            catch (WebView2RuntimeNotFoundException) { return 1; }
        }

        var application = new Application();
        if (args.Length == 1 && args[0] is "--activate" or "--activate-offline")
        {
            try
            {
                var activation = new ActivationWindow(ActivationBridge.Installed(AppContext.BaseDirectory),
                    offlineOnly: args[0] == "--activate-offline");
                // Only the Closed handler should choose the activation process exit code.
                application.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                activation.Closed += (_, _) => application.Shutdown(activation.ActivationAccepted ? 0 : 10);
                return application.Run(activation);
            }
            catch
            {
                MessageBox.Show("Start activation from the LEE T setup or repair process with administrator approval.", "LEE T Warehouse", MessageBoxButton.OK, MessageBoxImage.Information);
                return 3;
            }
        }
        if (args.Length != 0) return 2;
        return application.Run(CreateWindow());
    }

    internal static Window CreateWindow()
    {
        var window = new Window { Title = "LEE T Warehouse", Width = 1200, Height = 800, MinWidth = 420, MinHeight = 440 };
        var grid = new Grid();
        var browser = new WebView2 { Name = "WarehouseBrowser", Visibility = Visibility.Collapsed };
        var status = new TextBlock { Text = "Starting the warehouse…", TextWrapping = TextWrapping.Wrap };
        var retry = new Button { Name = "RetryConnection", Content = "Retry", Visibility = Visibility.Collapsed, Margin = new Thickness(0, 14, 0, 0) };
        var panel = new StackPanel { Margin = new Thickness(24), VerticalAlignment = VerticalAlignment.Center, MaxWidth = 480 };
        panel.Children.Add(status);
        panel.Children.Add(retry);
        grid.Children.Add(browser);
        grid.Children.Add(panel);
        window.Content = grid;
        var closing = new CancellationTokenSource();
        CoreWebView2Environment? environment = null;
        var loading = false;
        var initialized = false;

        void ShowFailure(string message)
        {
            browser.Visibility = Visibility.Collapsed;
            panel.Visibility = Visibility.Visible;
            status.Text = message;
            retry.Visibility = Visibility.Visible;
        }

        async Task OpenWarehouse()
        {
            if (loading || closing.IsCancellationRequested) return;
            loading = true;
            retry.Visibility = Visibility.Collapsed;
            status.Text = "Connecting to the local warehouse…";
            try
            {
                await WaitForWarehouse(closing.Token);
                if (!initialized)
                {
                    var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "LEE T", "Warehouse Desktop");
                    environment ??= await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
                    if (closing.IsCancellationRequested) return;
                    await browser.EnsureCoreWebView2Async(environment);
                    if (closing.IsCancellationRequested) return;
                    Configure(browser.CoreWebView2, window, environment);
                    browser.CoreWebView2.NavigationCompleted += (_, result) =>
                    {
                        if (result.IsSuccess)
                        {
                            panel.Visibility = Visibility.Collapsed;
                            browser.Visibility = Visibility.Visible;
                        }
                        else if (result.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                            ShowFailure("The warehouse page could not open. Check that the local service and certificate are ready, then retry.");
                    };
                    initialized = true;
                }
                browser.CoreWebView2.Navigate(new Uri(Warehouse, "/admin/").AbsoluteUri);
            }
            catch (OperationCanceledException) when (closing.IsCancellationRequested) { }
            catch (WebView2RuntimeNotFoundException)
            {
                if (!closing.IsCancellationRequested) ShowFailure("The desktop runtime is unavailable. Repair the LEE T installation, then retry.");
            }
            catch (Exception)
            {
                if (!closing.IsCancellationRequested) ShowFailure("The local warehouse is unavailable. Check the LEE T service, then retry.");
            }
            finally { loading = false; }
        }

        window.Loaded += async (_, _) => await OpenWarehouse();
        retry.Click += async (_, _) => await OpenWarehouse();
        window.Closed += (_, _) => { closing.Cancel(); browser.Dispose(); };
        return window;
    }

    private static async Task WaitForWarehouse(CancellationToken cancellation)
    {
        var endpoint = new Uri(Warehouse, "/api/commercial/server-identity");
        for (var attempt = 0; attempt < 12; attempt++)
        {
            try
            {
                using var response = await Server.GetAsync(endpoint, cancellation);
                if (response.IsSuccessStatusCode)
                {
                    using var identity = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation));
                    if (identity.RootElement.ValueKind == JsonValueKind.Object &&
                        identity.RootElement.TryGetProperty("schema", out var schema) && schema.ValueKind == JsonValueKind.Number &&
                        schema.TryGetInt32(out var version) && version == 1 &&
                        identity.RootElement.TryGetProperty("serverId", out var id) && id.ValueKind == JsonValueKind.String &&
                        Guid.TryParse(id.GetString(), out _)) return;
                }
            }
            catch (HttpRequestException) { }
            catch (JsonException) { }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { }
            await Task.Delay(750, cancellation);
        }
        throw new HttpRequestException("Warehouse service is not ready.");
    }

    private static bool IsWarehouse(string address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) &&
        uri.Scheme == Warehouse.Scheme && uri.Host == Warehouse.Host && uri.Port == Warehouse.Port &&
        string.IsNullOrEmpty(uri.UserInfo);

    private static void Configure(CoreWebView2 core, Window owner, CoreWebView2Environment environment)
    {
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.NavigationStarting += (_, args) => args.Cancel = !IsWarehouse(args.Uri);
        core.FrameNavigationStarting += (_, args) => args.Cancel = !IsWarehouse(args.Uri);
        core.DownloadStarting += (_, args) =>
        {
            args.Handled = true;
            var address = args.DownloadOperation.Uri;
            if (!IsWarehouse(address) &&
                !(address.StartsWith("blob:", StringComparison.Ordinal) && IsWarehouse(address[5..])))
            {
                args.Cancel = true;
                return;
            }
            var deferral = args.GetDeferral();
            owner.Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    var dialog = new SaveFileDialog
                    {
                        FileName = Path.GetFileName(args.ResultFilePath), OverwritePrompt = true,
                        RestoreDirectory = true,
                    };
                    if (dialog.ShowDialog(owner) == true) args.ResultFilePath = dialog.FileName;
                    else args.Cancel = true;
                }
                catch { args.Cancel = true; }
                finally { deferral.Complete(); }
            }));
        };
        core.NewWindowRequested += async (_, args) =>
        {
            args.Handled = true;
            if (!IsWarehouse(args.Uri) || !args.IsUserInitiated) return;
            var deferral = args.GetDeferral();
            var childBrowser = new WebView2();
            var child = new Window
            {
                Title = "LEE T Warehouse", Owner = owner, Width = 850, Height = 650, Content = childBrowser,
            };
            child.Closed += (_, _) => childBrowser.Dispose();
            try
            {
                child.Show();
                await childBrowser.EnsureCoreWebView2Async(environment);
                Configure(childBrowser.CoreWebView2, child, environment);
                args.NewWindow = childBrowser.CoreWebView2;
            }
            catch { child.Close(); }
            finally { deferral.Complete(); }
        };
    }
}
