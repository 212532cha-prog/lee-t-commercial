using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace LeeT.LicenseCenter;

internal sealed class IssuerClient : IDisposable
{
    private readonly HttpClient http;
    private readonly X509Certificate2 certificate;
    private readonly Uri origin;

    public IssuerClient(string root, string password)
    {
        using var settings = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "management.private.json")));
        origin = new Uri(settings.RootElement.GetProperty("origin").GetString()!);
        if (origin.Scheme != Uri.UriSchemeHttps || origin.Host != "127.0.0.1" ||
            origin.PathAndQuery != "/" || origin.Fragment != "" || origin.UserInfo != "")
            throw new InvalidDataException("INVALID_LOCAL_ORIGIN");
        using var ca = new X509Certificate2(Path.Combine(root, "management-ca.cer"));
        var caHash = ca.GetCertHashString(HashAlgorithmName.SHA256);
        using var publicOperator = new X509Certificate2(Path.Combine(root, "operator.cer"));
        using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
        store.Open(OpenFlags.ReadOnly);
        certificate = store.Certificates.Find(X509FindType.FindByThumbprint, publicOperator.Thumbprint, false)
            .Cast<X509Certificate2>().FirstOrDefault(candidate => candidate.HasPrivateKey)
            ?? throw new InvalidDataException("OPERATOR_CERTIFICATE_REQUIRED");
        var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false };
        handler.ClientCertificates.Add(certificate);
        handler.ServerCertificateCustomValidationCallback = (_, _, chain, errors) =>
            errors == SslPolicyErrors.None && chain != null && chain.ChainElements.Count > 1 &&
            chain.ChainElements[^1].Certificate.GetCertHashString(HashAlgorithmName.SHA256) == caHash;
        http = new HttpClient(handler) { BaseAddress = origin, Timeout = TimeSpan.FromSeconds(20), MaxResponseContentBufferSize = 2 * 1024 * 1024 };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes("issuer:" + password)));
    }

    private async Task<JsonElement> Call(string path, object? payload = null)
    {
        using var request = new HttpRequestMessage(payload == null ? HttpMethod.Get : HttpMethod.Post, path);
        if (payload != null)
        {
            request.Content = JsonContent.Create(payload, mediaType: new MediaTypeHeaderValue("application/json"));
            request.Content.Headers.ContentType!.CharSet = null;
            request.Headers.Add("Origin", origin.GetLeftPart(UriPartial.Authority));
        }
        using var response = await http.SendAsync(request);
        using var document = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync());
        if (!response.IsSuccessStatusCode)
            throw new IssuerException(document.RootElement.TryGetProperty("error", out var code) ? code.GetString()! : "REQUEST_REJECTED");
        return document.RootElement.Clone();
    }

    public Task<JsonElement> Customers() => Call("/api/customers");
    public Task<JsonElement> AddCustomer(string companyName) => Call("/api/customers", new { companyName });
    public Task<JsonElement> Payments(Guid customerId) => Call("/api/payments?customerId=" + customerId);
    public Task<JsonElement> AddPayment(Guid customerId, string receiptReference, string kind, string version) =>
        Call("/api/payments", new { customerId, receiptReference, kind, version });
    public Task<JsonElement> Sign(Guid customerId, Guid paymentId, string priorLicenseId, JsonElement request) =>
        Call("/api/sign-offline", new { customerId, paymentId, priorLicenseId, request });

    public static JsonElement ReadRequest(string path)
    {
        using var file = File.OpenRead(path);
        if (file.Length is < 1 or > 4096) throw new InvalidDataException("INVALID_DEVICE_REQUEST");
        var bytes = new byte[(int)file.Length];
        file.ReadExactly(bytes);
        using var document = JsonDocument.Parse(Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF'));
        if (document.RootElement.ValueKind != JsonValueKind.Object ||
            !document.RootElement.TryGetProperty("installationId", out var id) ||
            id.ValueKind != JsonValueKind.String || !Guid.TryParse(id.GetString(), out _))
            throw new InvalidDataException("INVALID_DEVICE_REQUEST");
        return document.RootElement.Clone();
    }

    public void Dispose()
    {
        http.Dispose();
        certificate.Dispose();
    }
}

internal sealed class IssuerException(string code) : Exception(code);
