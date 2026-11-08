using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;

namespace LeeT.Desktop;

internal interface IActivationFiles
{
    string? SaveRequest(Window owner);
    string? OpenLicense(Window owner);
}

internal sealed class ActivationFiles : IActivationFiles
{
    public string? SaveRequest(Window owner)
    {
        var dialog = new SaveFileDialog { FileName = "LEE-T-device-request.json", Filter = "Device request (*.json)|*.json", OverwritePrompt = true, RestoreDirectory = true };
        return dialog.ShowDialog(owner) == true ? dialog.FileName : null;
    }
    public string? OpenLicense(Window owner)
    {
        var dialog = new OpenFileDialog { Filter = "Signed license (*.json)|*.json", CheckFileExists = true, Multiselect = false, RestoreDirectory = true };
        return dialog.ShowDialog(owner) == true ? dialog.FileName : null;
    }
}

internal sealed class ActivationWindow : Window
{
    private readonly IActivationBridge bridge;
    private readonly IActivationFiles files;
    private readonly CancellationTokenSource closing = new();
    private readonly TextBlock status = Text("Checking this installation…", 14, "#475569");
    internal readonly PasswordBox Code = new() { Name = "ActivationCode", Height = 42, Padding = new Thickness(10), FontSize = 16, MaxLength = 100 };
    internal readonly Button Online = Button("ActivateOnline", "Activate", true);
    internal readonly Button Export = Button("ExportRequest", "1. Export device request");
    internal readonly Button Import = Button("ImportLicense", "2. Import signed license");
    internal readonly Button Continue = Button("ContinueSetup", "Continue setup", true);
    internal bool ActivationAccepted { get; private set; }
    internal bool Busy { get; private set; }
    internal string Status => status.Text;
    private bool activated;

    internal ActivationWindow(IActivationBridge bridge, IActivationFiles? files = null)
    {
        this.bridge = bridge;
        this.files = files ?? new ActivationFiles();
        Title = "Activate LEE T Warehouse";
        Width = 620; Height = 710; MinWidth = 480; MinHeight = 620;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#F3F6FB"));
        var body = new StackPanel { Margin = new Thickness(32), MaxWidth = 520 };
        body.Children.Add(Text("LEE T", 30, "#1E40AF", FontWeights.Bold));
        body.Children.Add(Text("Activate your warehouse", 24, "#0F172A", FontWeights.SemiBold));
        body.Children.Add(Text("Activate once on this computer. Your warehouse data stays here and your licensed version can work without the internet.", 14, "#64748B"));
        var online = new StackPanel();
        online.Children.Add(Text("Activation key", 16, "#0F172A", FontWeights.SemiBold));
        online.Children.Add(Text("Enter the key supplied with your LEE T purchase.", 13, "#64748B"));
        online.Children.Add(Code); online.Children.Add(Online);
        body.Children.Add(Card(online));
        var offline = new StackPanel();
        offline.Children.Add(Text("Offline activation", 16, "#0F172A", FontWeights.SemiBold));
        offline.Children.Add(Text("Export the request and send it to your LEE T provider. Import the signed license they return.", 13, "#64748B"));
        offline.Children.Add(Export); offline.Children.Add(Import);
        body.Children.Add(Card(offline));
        body.Children.Add(status);
        body.Children.Add(Continue);
        var cancel = Button("CancelActivation", "Close");
        cancel.Click += (_, _) => Close();
        body.Children.Add(cancel);
        Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Code.PasswordChanged += (_, _) => UpdateControls();
        Continue.Click += (_, _) => { if (!Busy && activated) { ActivationAccepted = true; Close(); } };
        Online.Click += async (_, _) => await Run(async () =>
        {
            try { await RequireSuccess(new { schema = 1, action = "activate", code = Code.Password.Trim() }); await CheckStatus(true); }
            finally { Code.Clear(); }
        });
        Export.Click += async (_, _) =>
        {
            if (Busy || activated) return;
            var path = this.files.SaveRequest(this);
            if (path == null) return;
            await Run(async () =>
            {
                if (!bridge.CanExportRequestTo(path)) throw new InvalidOperationException();
                var result = await RequireSuccess(new { schema = 1, action = "request" });
                var request = result.GetProperty("request");
                if (request.ValueKind != JsonValueKind.Object) throw new InvalidOperationException();
                await File.WriteAllTextAsync(path, JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true }), closing.Token);
                status.Text = "Device request saved. Send it to your LEE T provider, then import the signed license.";
            });
        };
        Import.Click += async (_, _) =>
        {
            if (Busy || activated) return;
            var path = this.files.OpenLicense(this);
            if (path == null) return;
            await Run(async () =>
            {
                await using var stream = File.OpenRead(path);
                using var license = JsonDocument.Parse(await ActivationBridge.ReadBounded(stream, 16384, closing.Token));
                await RequireSuccess(new { schema = 1, action = "import", license = license.RootElement });
                await CheckStatus(true);
            });
        };
        Loaded += async (_, _) => await Run(() => CheckStatus(false));
        Closed += (_, _) => { closing.Cancel(); Code.Clear(); };
        UpdateControls();
    }

    private async Task<JsonElement> RequireSuccess(object input)
    {
        var response = await bridge.Send(input, closing.Token);
        if (!response.GetProperty("ok").GetBoolean()) throw new InvalidOperationException();
        return response;
    }

    private async Task CheckStatus(bool requireActivated)
    {
        var result = await RequireSuccess(new { schema = 1, action = "status" });
        activated = result.GetProperty("state").GetString() == "activated";
        if (requireActivated && !activated) throw new InvalidOperationException();
        status.Text = activated ? "Activation verified. Continue setup to prepare your warehouse." : "Ready to activate. Use your purchase key or the offline options above.";
    }

    private async Task Run(Func<Task> operation)
    {
        if (Busy || closing.IsCancellationRequested) return;
        Busy = true; status.Text = "Please wait…"; UpdateControls();
        try { await operation(); }
        catch (OperationCanceledException) when (closing.IsCancellationRequested) { }
        catch { if (!closing.IsCancellationRequested) status.Text = "Activation could not be verified. Check your key or signed license and retry. You can close and reopen setup safely."; }
        finally { Busy = false; UpdateControls(); }
    }

    private void UpdateControls()
    {
        Code.IsEnabled = !Busy && !activated;
        Online.IsEnabled = !Busy && !activated && System.Text.RegularExpressions.Regex.IsMatch(Code.Password.Trim(), "^LT-[A-Za-z0-9_-]{32}$");
        Export.IsEnabled = Import.IsEnabled = !Busy && !activated;
        Continue.IsEnabled = !Busy && activated;
    }

    private static TextBlock Text(string value, double size, string color, FontWeight? weight = null) => new()
    {
        Text = value, FontSize = size, TextWrapping = TextWrapping.Wrap,
        Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(color)),
        FontWeight = weight ?? FontWeights.Normal, Margin = new Thickness(0, 0, 0, 10),
    };
    private static Border Card(UIElement content) => new()
    {
        Child = content, Background = Brushes.White, CornerRadius = new CornerRadius(12), Padding = new Thickness(20),
        BorderBrush = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#E2E8F0")), BorderThickness = new Thickness(1), Margin = new Thickness(0, 8, 0, 14),
    };
    private static Button Button(string name, string text, bool primary = false) => new()
    {
        Name = name, Content = text, MinHeight = 38, Padding = new Thickness(14, 6, 14, 6),
        Margin = new Thickness(0, 8, 0, 0), HorizontalContentAlignment = HorizontalAlignment.Center,
        Background = primary ? new SolidColorBrush((Color)ColorConverter.ConvertFromString("#2563EB")) : Brushes.White,
        Foreground = primary ? Brushes.White : new SolidColorBrush((Color)ColorConverter.ConvertFromString("#334155")),
        BorderBrush = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#CBD5E1")), FontSize = 14,
    };
}
