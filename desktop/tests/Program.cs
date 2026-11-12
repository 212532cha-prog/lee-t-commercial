using System.Net.Http;
using System.Windows;
using System.Text.Json;
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
                Require(window.Icon is not null, "The warehouse window must use the LEE T application icon.");
                await ActivationChecks.Run();
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
                Require(new Uri(browser.CoreWebView2.Source).AbsolutePath == "/admin/", "Desktop must open the bundled management workspace.");
                Require(!browser.CoreWebView2.Settings.AreHostObjectsAllowed, "Host objects must be disabled.");
                Require(!browser.CoreWebView2.Settings.IsWebMessageEnabled, "Host messages must be disabled.");
                Require(!browser.CoreWebView2.Settings.AreDevToolsEnabled, "Developer tools must be disabled.");
                var management = Environment.GetEnvironmentVariable("LEET_DESKTOP_MANAGEMENT") == "1";
                if (management) await CheckManagement(browser);
                else {
                Require(await browser.ExecuteScriptAsync("document.title") == "\"LEE T desktop fixture\"", "Warehouse page did not render.");
                await browser.ExecuteScriptAsync("fetch('/session', {method:'POST'}).then(r=>r.text()).then(value=>document.body.dataset.session=value)");
                await Until(async () => await browser.ExecuteScriptAsync("document.body.dataset.session") == "\"signed-in\"");
                var reload = new TaskCompletionSource<bool>();
                browser.CoreWebView2.NavigationCompleted += (_, result) => reload.TrySetResult(result.IsSuccess);
                browser.Reload();
                Require(await reload.Task.WaitAsync(TimeSpan.FromSeconds(15)), "Warehouse reload failed.");
                await browser.ExecuteScriptAsync("fetch('/session').then(r=>r.text()).then(value=>document.body.dataset.session=value)");
                await Until(async () => await browser.ExecuteScriptAsync("document.body.dataset.session") == "\"signed-in\"");
                }
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

    private static async Task CheckManagement(WebView2 browser)
    {
        Require(await browser.ExecuteScriptAsync("document.title") == "\"LEE T Administration\"", "Built management entry did not render.");
        await Until(async () => await browser.ExecuteScriptAsync("!!document.querySelector('.sign-in-form')") == "true");
        await browser.ExecuteScriptAsync("(()=>{globalThis.__desktopFailures=[];globalThis.__desktopPending=0;const original=globalThis.fetch;globalThis.fetch=(...args)=>{globalThis.__desktopPending++;return original(...args).then(response=>{if(!response.ok)globalThis.__desktopFailures.push(new URL(response.url).pathname+':'+response.status);return response}).finally(()=>globalThis.__desktopPending--)};globalThis.addEventListener('error',event=>globalThis.__desktopFailures.push('script:'+event.message));globalThis.addEventListener('unhandledrejection',()=>globalThis.__desktopFailures.push('unhandled rejection'))})()");
        var password = JsonSerializer.Serialize(Environment.GetEnvironmentVariable("LEET_DESKTOP_TEST_PASSWORD") ?? throw new InvalidOperationException("Missing fixture password."));
        await browser.ExecuteScriptAsync("(()=>{const form=document.querySelector('.sign-in-form');const set=(selector,value)=>{const input=form.querySelector(selector);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))};set('input[type=text]','CTL LEE');set('input[type=password]'," + password + ");form.requestSubmit()})()");
        await Until(async () => await browser.ExecuteScriptAsync("!!document.querySelector('.warehouse-shell') && document.body.textContent.includes('Warehouse overview')") == "true");
        Require(await browser.ExecuteScriptAsync("document.body.textContent.includes('Administrator')") == "true", "Administrator display name missing.");
        foreach (var section in new[] { "Products", "Master data", "Stocktakes", "Product costs", "Data export", "Employees and devices", "Backups", "My account", "Stock movements" })
        {
            var label = JsonSerializer.Serialize(section);
            await browser.ExecuteScriptAsync("[...document.querySelectorAll('.el-menu-item')].find(element=>element.textContent.trim()===" + label + ").click()");
            await Until(async () => await browser.ExecuteScriptAsync("document.querySelector('.warehouse-topbar')?.textContent.includes(" + label + ")") == "true");
            await Until(async () => await browser.ExecuteScriptAsync("globalThis.__desktopPending === 0") == "true");
            if (section == "Products") await Until(async () => await browser.ExecuteScriptAsync("document.body.textContent.includes('Desktop test bolt')") == "true");
            await Until(async () => await browser.ExecuteScriptAsync("!document.querySelector('.el-loading-mask') || [...document.querySelectorAll('.el-loading-mask')].every(element=>element.getClientRects().length===0)") == "true");
        }
        Require(await browser.ExecuteScriptAsync("globalThis.__desktopFailures.length") == "0", "A management module failed a real warehouse request or script.");
        await browser.ExecuteScriptAsync("fetch('/api/me').then(r=>r.json()).then(value=>document.body.dataset.checkedRole=value.user.role)");
        await Until(async () => await browser.ExecuteScriptAsync("document.body.dataset.checkedRole") == "\"admin\"");
        var reloaded = new TaskCompletionSource<bool>();
        browser.CoreWebView2.NavigationCompleted += (_, result) => reloaded.TrySetResult(result.IsSuccess);
        browser.Reload();Require(await reloaded.Task.WaitAsync(TimeSpan.FromSeconds(15)), "Management reload failed.");
        await Until(async () => await browser.ExecuteScriptAsync("!!document.querySelector('.warehouse-shell') && document.body.textContent.includes('Warehouse overview')") == "true");
        Require(await browser.ExecuteScriptAsync("!!document.querySelector('.sign-in-form')") == "false", "Reload lost the real warehouse session.");
        Console.WriteLine("Real built management in WebView2: PostgreSQL login, nine module entries, Administrator branding and session reload passed.");
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
