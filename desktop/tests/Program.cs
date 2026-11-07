using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Wpf;

internal static class Smoke
{
    [STAThread]
    public static int Main()
    {
        var application = new Application();
        var window = LeeT.Desktop.Program.CreateWindow();
        window.Loaded += async (_, _) =>
        {
            try
            {
                var grid = (Grid)window.Content;
                var browser = grid.Children.OfType<WebView2>().Single();
                var retry = ((StackPanel)grid.Children[1]).Children.OfType<Button>().Single();
                await Until(() => retry.Visibility == Visibility.Visible);
                Require(browser.Visibility == Visibility.Collapsed, "Service unavailable must show recovery.");
                using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
                using var ready = await http.PostAsync("https://localhost:3443/ready", null);
                ready.EnsureSuccessStatusCode();
                retry.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(() => browser.Visibility == Visibility.Visible);
                Require(await browser.ExecuteScriptAsync("document.title") == "\"LEE T desktop fixture\"", "Warehouse page did not render.");
                Require(!browser.CoreWebView2.Settings.AreHostObjectsAllowed, "Host objects must be disabled.");
                Require(!browser.CoreWebView2.Settings.IsWebMessageEnabled, "Host messages must be disabled.");
                Require(!browser.CoreWebView2.Settings.AreDevToolsEnabled, "Developer tools must be disabled.");
                await browser.ExecuteScriptAsync("fetch('/session', {method:'POST'}).then(r=>r.text()).then(value=>document.body.dataset.session=value)");
                await Until(async () => await browser.ExecuteScriptAsync("document.body.dataset.session") == "\"signed-in\"");
                var reload = new TaskCompletionSource<bool>();
                browser.CoreWebView2.NavigationCompleted += (_, result) => reload.TrySetResult(result.IsSuccess);
                browser.Reload();
                Require(await reload.Task.WaitAsync(TimeSpan.FromSeconds(15)), "Warehouse reload failed.");
                await browser.ExecuteScriptAsync("fetch('/session').then(r=>r.text()).then(value=>document.body.dataset.session=value)");
                await Until(async () => await browser.ExecuteScriptAsync("document.body.dataset.session") == "\"signed-in\"");
                var navigation = new TaskCompletionSource<bool>();
                browser.CoreWebView2.NavigationStarting += (_, args) =>
                {
                    if (args.Uri.StartsWith("https://example.invalid/", StringComparison.Ordinal))
                        navigation.TrySetResult(args.Cancel);
                };
                browser.CoreWebView2.Navigate("https://example.invalid/");
                Require(await navigation.Task.WaitAsync(TimeSpan.FromSeconds(10)), "External navigation was not blocked.");
                await Task.Delay(300);
                Require(browser.Visibility == Visibility.Visible, "Blocked navigation must keep the current workspace visible.");
                Require(new Uri(browser.CoreWebView2.Source).Host == "localhost", "External page replaced the warehouse.");
                Console.WriteLine("Desktop service recovery, real WebView2 rendering, session reload and external navigation checks passed.");
                application.Shutdown(0);
            }
            catch (Exception failure)
            {
                Console.Error.WriteLine(failure);
                application.Shutdown(1);
            }
        };
        return application.Run(window);
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static Task Until(Func<bool> condition) => Until(() => Task.FromResult(condition()));

    private static async Task Until(Func<Task<bool>> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(45);
        while (DateTime.UtcNow < deadline)
        {
            if (await condition()) return;
            await Task.Delay(150);
        }
        throw new TimeoutException("Desktop condition did not complete.");
    }
}
