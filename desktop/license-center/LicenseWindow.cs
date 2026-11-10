using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace LeeT.LicenseCenter;

internal sealed class LicenseWindow : Window
{
    private static readonly Brush Ink = new SolidColorBrush(Color.FromRgb(27, 38, 56));
    private static readonly Brush Muted = new SolidColorBrush(Color.FromRgb(85, 100, 119));
    private static readonly Brush Accent = new SolidColorBrush(Color.FromRgb(32, 78, 129));
    private readonly StackPanel content = new();
    private readonly StackPanel workspace = new() { IsEnabled = false };
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Foreground = Muted };
    private readonly TextBlock steps = new() { Foreground = Accent, Margin = new Thickness(0, 0, 0, 12), TextWrapping = TextWrapping.Wrap };
    private readonly PasswordBox password = new() { MaxLength = 128 };
    private readonly ComboBox customers = new() { DisplayMemberPath = "Name" };
    private readonly ComboBox payments = new() { DisplayMemberPath = "Name" };
    private readonly ComboBox kind = new() { ItemsSource = new[] { "initial", "upgrade", "transfer" }, SelectedIndex = 0 };
    private readonly TextBox company = new() { MaxLength = 120 };
    private readonly TextBox receipt = new() { MaxLength = 120 };
    private readonly TextBox version = new() { MaxLength = 32 };
    private readonly TextBox prior = new() { MaxLength = 36 };
    private readonly TextBlock selectedFile = new() { Foreground = Muted, TextWrapping = TextWrapping.Wrap };
    private readonly List<Action<int>> translations = new();
    private readonly Button sign;
    private IssuerClient? client;
    private JsonElement? request;
    private bool busy;
    private bool loading;
    private int language;

    private sealed record Choice(Guid Id, string Name, string Kind = "");

    public LicenseWindow(string root)
    {
        Title = "LEE T License Center";
        Width = 760; Height = 800; MinWidth = 440; MinHeight = 480;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(Color.FromRgb(240, 244, 249));
        Foreground = Ink;
        FontFamily = new FontFamily("Segoe UI");
        FontSize = 14;
        content.Margin = new Thickness(32, 24, 32, 28);
        content.MaxWidth = 680;
        Content = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };

        var locale = new ComboBox { ItemsSource = new[] { "English", "简体中文", "Bahasa Melayu" }, SelectedIndex = 0, Width = 145, HorizontalAlignment = HorizontalAlignment.Right };
        content.Children.Add(locale);
        var logo = new BitmapImage(new Uri("pack://application:,,,/lee-t-logo.jpg"));
        Icon = logo;
        content.Children.Add(new Image { Source = logo, Width = 68, Height = 48, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Left });
        content.Children.Add(new TextBlock { Text = Title, FontSize = 32, FontWeight = FontWeights.SemiBold });
        var subtitle = new TextBlock { Foreground = Muted, Margin = new Thickness(0, 3, 0, 18) };
        Translate(value => subtitle.Text = value, "Offline license signing", "离线许可证签发", "Tandatangan lesen luar talian");
        content.Children.Add(subtitle);
        content.Children.Add(steps);
        Card(content).Children.Add(status);

        var connection = Card(content);
        Field(connection, password, "Issuer password", "签发员密码", "Kata laluan pengeluar");
        var connect = ActionButton(connection, "Connect to local issuer", "连接本机签发服务", "Sambung kepada pengeluar tempatan");
        connect.Click += async (_, _) => await Run(async () =>
        {
            var pending = new IssuerClient(root, password.Password);
            password.Clear();
            JsonElement rows;
            try { rows = await pending.Customers(); }
            catch { pending.Dispose(); throw; }
            client?.Dispose();
            client = pending;
            FillCustomers(rows, null);
            await ReloadPayments();
            Tell("Connected. Select a customer.", "已连接。请选择客户。", "Disambungkan. Pilih pelanggan.");
        });
        content.Children.Add(workspace);

        var customerCard = Card(workspace);
        Field(customerCard, customers, "1  Customer", "1  客户", "1  Pelanggan");
        Field(customerCard, company, "New customer name", "新客户名称", "Nama pelanggan baharu");
        ActionButton(customerCard, "Register customer", "登记客户", "Daftar pelanggan").Click += async (_, _) => await Run(async () =>
        {
            var added = await client!.AddCustomer(company.Text.Trim());
            FillCustomers(await client.Customers(), added.GetProperty("id").GetGuid());
            company.Clear();
            await ReloadPayments();
        });
        customers.SelectionChanged += async (_, _) =>
        {
            if (!loading && !busy) await Run(ReloadPayments);
        };

        var paymentCard = Card(workspace);
        Field(paymentCard, payments, "2  Confirmed payment", "2  已确认付款", "2  Bayaran disahkan");
        Field(paymentCard, receipt, "New payment receipt reference", "新付款收据编号", "Rujukan resit bayaran baharu");
        Field(paymentCard, version, "Licensed version", "授权版本", "Versi berlesen");
        Field(paymentCard, kind, "Purchase type", "购买类型", "Jenis pembelian");
        ActionButton(paymentCard, "Record confirmed payment", "登记已确认付款", "Rekod bayaran disahkan").Click += async (_, _) => await Run(async () =>
        {
            if (customers.SelectedItem is not Choice customer) throw new IssuerException("SELECT_CUSTOMER");
            var added = await client!.AddPayment(customer.Id, receipt.Text.Trim(), (string)kind.SelectedItem, version.Text.Trim());
            receipt.Clear();
            await ReloadPayments(added.GetProperty("id").GetGuid());
        });

        var signing = Card(workspace);
        Field(signing, prior, "Previous license ID for upgrade or transfer", "升级或换机的原许可证 ID", "ID lesen lama untuk naik taraf atau pindah");
        ActionButton(signing, "3  Choose device request", "3  选择设备请求", "3  Pilih permintaan peranti").Click += (_, _) =>
        {
            var picker = new OpenFileDialog { Filter = "JSON (*.json)|*.json" };
            if (picker.ShowDialog(this) != true) return;
            request = null;
            selectedFile.Text = "";
            try
            {
                request = IssuerClient.ReadRequest(picker.FileName);
                selectedFile.Text = Path.GetFileName(picker.FileName) + "  ·  " + request.Value.GetProperty("installationId").GetString();
                Tell("Device request loaded.", "设备请求已载入。", "Permintaan peranti dimuatkan.");
            }
            catch { Tell("Could not read the device request JSON.", "无法读取设备请求 JSON。", "JSON permintaan peranti tidak dapat dibaca."); }
            UpdateProgress();
        };
        signing.Children.Add(selectedFile);
        sign = ActionButton(signing, "4  Sign and save license", "4  签发并保存许可证", "4  Tandatangan dan simpan lesen");
        sign.Background = Accent;
        sign.Foreground = Brushes.White;
        sign.Click += async (_, _) =>
        {
            if (customers.SelectedItem is not Choice customer || payments.SelectedItem is not Choice payment || request is not JsonElement device) return;
            var save = new SaveFileDialog { Filter = "JSON (*.json)|*.json", FileName = "LeeT-signed-license.json", AddExtension = true, OverwritePrompt = true };
            if (save.ShowDialog(this) != true) return;
            await Run(async () =>
            {
                var destination = Path.GetFullPath(save.FileName);
                var protectedRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
                if (destination.StartsWith(protectedRoot, StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(Path.GetExtension(destination), ".json", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Invalid license destination.");
                var temporary = Path.Combine(Path.GetDirectoryName(destination)!, ".leet-" + Guid.NewGuid().ToString("N") + ".tmp");
                try
                {
                    await using (var stream = new FileStream(temporary, FileMode.CreateNew))
                    {
                        var license = await client!.Sign(customer.Id, payment.Id, payment.Kind == "initial" ? "" : prior.Text.Trim(), device);
                        await JsonSerializer.SerializeAsync(stream, license, new JsonSerializerOptions { WriteIndented = true });
                    }
                    File.Move(temporary, destination, overwrite: true);
                }
                finally { File.Delete(temporary); }
                Tell("Signed and saved · " + Path.GetFileName(save.FileName), "已签发并保存 · " + Path.GetFileName(save.FileName), "Ditandatangani dan disimpan · " + Path.GetFileName(save.FileName));
            });
        };
        payments.SelectionChanged += (_, _) => UpdateProgress();
        prior.TextChanged += (_, _) => UpdateProgress();
        locale.SelectionChanged += (_, _) =>
        {
            language = locale.SelectedIndex;
            foreach (var apply in translations) apply(language);
            UpdateProgress();
            Tell("Ready.", "已就绪。", "Sedia.");
        };
        Tell("Start the local License Center service, then connect.", "请启动本机 License Center 服务后连接。", "Mulakan perkhidmatan License Center tempatan, kemudian sambung.");
        UpdateProgress();
    }

    private void Translate(Action<string> apply, params string[] values)
    {
        translations.Add(index => apply(values[index]));
        apply(values[language]);
    }

    private StackPanel Card(Panel parent)
    {
        var body = new StackPanel();
        parent.Children.Add(new Border
        {
            Background = Brushes.White, CornerRadius = new CornerRadius(12), Padding = new Thickness(18),
            Margin = new Thickness(0, 0, 0, 12), Child = body
        });
        return body;
    }

    private void Field(Panel panel, Control field, params string[] names)
    {
        var label = new Label { Target = field, Padding = new Thickness(0), FontWeight = FontWeights.SemiBold };
        Translate(value => label.Content = value, names);
        panel.Children.Add(label);
        field.MinHeight = 32;
        field.Margin = new Thickness(0, 4, 0, 10);
        panel.Children.Add(field);
    }

    private Button ActionButton(Panel panel, params string[] names)
    {
        var button = new Button { HorizontalAlignment = HorizontalAlignment.Left, Padding = new Thickness(14, 7, 14, 7), Margin = new Thickness(0, 4, 0, 4) };
        Translate(value => button.Content = value, names);
        panel.Children.Add(button);
        return button;
    }

    private void FillCustomers(JsonElement rows, Guid? selected)
    {
        loading = true;
        try
        {
            customers.ItemsSource = rows.EnumerateArray().Select(row => new Choice(row.GetProperty("id").GetGuid(), row.GetProperty("company_name").GetString()!)).ToList();
            customers.SelectedItem = ((List<Choice>)customers.ItemsSource).Find(item => item.Id == selected);
        }
        finally { loading = false; }
    }

    private async Task ReloadPayments(Guid? selected)
    {
        request = null;
        selectedFile.Text = "";
        prior.Clear();
        payments.ItemsSource = null;
        if (customers.SelectedItem is not Choice customer) return;
        var rows = await client!.Payments(customer.Id);
        var choices = rows.EnumerateArray()
            .Where(row => row.GetProperty("status").GetString() is "confirmed" or "expired" or "redeemed")
            .Select(row => new Choice(row.GetProperty("id").GetGuid(),
                string.Join(" · ", new[] { "receipt_reference", "kind", "version", "status" }.Select(key => row.GetProperty(key).GetString())),
                row.GetProperty("kind").GetString()!)).ToList();
        payments.ItemsSource = choices;
        payments.SelectedItem = choices.Find(item => item.Id == selected);
    }

    private Task ReloadPayments() => ReloadPayments(null);

    private void UpdateProgress()
    {
        var next = customers.SelectedItem == null ? 1 : payments.SelectedItem == null ? 2 : request == null ? 3 : 4;
        var labels = new[] { "Customer|Payment|Request|Save", "客户|付款|请求|保存", "Pelanggan|Bayaran|Permintaan|Simpan" }[language].Split('|');
        steps.Text = string.Join("  →  ", labels.Select((label, index) => (index + 1 == next ? "● " : "") + label));
        if (sign != null)
            sign.IsEnabled = next == 4 && payments.SelectedItem is Choice payment &&
                (payment.Kind == "initial" || Guid.TryParse(prior.Text.Trim(), out _));
    }

    private void Tell(params string[] message)
    {
        status.Text = message[language];
        if (SystemParameters.ClientAreaAnimation)
            status.BeginAnimation(OpacityProperty, new DoubleAnimation(0.5, 1, TimeSpan.FromMilliseconds(180)));
    }

    private async Task Run(Func<Task> action)
    {
        if (busy) return;
        busy = true;
        foreach (UIElement child in content.Children) if (child is Control || child is Panel || child is Border) child.IsEnabled = false;
        Tell("Working…", "处理中…", "Sedang diproses…");
        try
        {
            await action();
            if (status.Text is "Working…" or "处理中…" or "Sedang diproses…") Tell("Ready.", "已就绪。", "Sedia.");
        }
        catch (IssuerException error)
        {
            Tell("Request declined · " + error.Message, "请求被拒绝 · " + error.Message, "Permintaan ditolak · " + error.Message);
        }
        catch
        {
            Tell("Could not complete the action. Check the local service, certificate or file path.",
                "操作未完成。请检查本机服务、证书或文件路径。",
                "Tindakan gagal. Semak perkhidmatan tempatan, sijil atau laluan fail.");
        }
        finally
        {
            busy = false;
            foreach (UIElement child in content.Children) if (child is Control || child is Panel || child is Border) child.IsEnabled = true;
            workspace.IsEnabled = client != null;
            UpdateProgress();
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        client?.Dispose();
        base.OnClosed(e);
    }
}
