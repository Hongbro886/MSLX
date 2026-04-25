using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Primitives;
using MSLX.Daemon.Models;
using MSLX.Daemon.Utils;
using Newtonsoft.Json.Linq;

namespace MSLX.Daemon.Controllers.FrpControllers.Providers;

[ApiController]
[Route("api/frp/loliafrp")]
[Authorize(Roles = "admin")]
public class LoliaFrpProxyController : ControllerBase
{
    private const string LoliaFrpApiBaseUrl = "https://api.lolia.io";

    [HttpGet("userinfo")]
    public Task<IActionResult> GetUserInfo()
        => ForwardGetAsync($"{LoliaFrpApiBaseUrl}/user/info");

    [HttpGet("tunnel")]
    public Task<IActionResult> GetTunnels([FromQuery] string? page, [FromQuery] string? limit)
    {
        var url = $"{LoliaFrpApiBaseUrl}/user/tunnel";
        var queryParams = new List<string>();
        if (!string.IsNullOrEmpty(page)) queryParams.Add($"page={page}");
        if (!string.IsNullOrEmpty(limit)) queryParams.Add($"limit={limit}");
        if (queryParams.Count > 0) url += "?" + string.Join("&", queryParams);
        return ForwardGetAsync(url);
    }

    [HttpPost("tunnel")]
    public async Task<IActionResult> CreateTunnel([FromBody] JToken body)
    {
        var response = await GeneralApi.PostAsync(
            $"{LoliaFrpApiBaseUrl}/user/tunnel",
            HttpService.PostContentType.Json,
            body,
            BuildProxyHeaders());

        return BuildActionResult(response);
    }

    [HttpGet("tunnel/{tunnelName}")]
    public Task<IActionResult> GetTunnel(string tunnelName)
        => ForwardGetAsync($"{LoliaFrpApiBaseUrl}/user/tunnel/{Uri.EscapeDataString(tunnelName)}");

    [HttpDelete("tunnel/{tunnelName}")]
    public Task<IActionResult> DeleteTunnel(string tunnelName)
        => ForwardDeleteAsync($"{LoliaFrpApiBaseUrl}/user/tunnel/{Uri.EscapeDataString(tunnelName)}");
    public Task<IActionResult> GetNodes()
        => ForwardPostAsync($"{LoliaFrpApiBaseUrl}/user/nodes", null);

    [HttpGet("traffic")]
    public Task<IActionResult> GetTrafficStats()
        => ForwardGetAsync($"{LoliaFrpApiBaseUrl}/user/traffic/stats");

    [HttpGet("traffic/tunnel/{tunnelId}")]
    public Task<IActionResult> GetTunnelTraffic(string tunnelId)
        => ForwardGetAsync($"{LoliaFrpApiBaseUrl}/user/traffic/tunnel/{Uri.EscapeDataString(tunnelId)}");

    [HttpGet("frpc-config")]
    public Task<IActionResult> GetFrpcConfig([FromQuery] string? tunnel)
    {
        var url = $"{LoliaFrpApiBaseUrl}/user/frpc/config";
        if (!string.IsNullOrEmpty(tunnel)) url += $"?tunnel={Uri.EscapeDataString(tunnel)}";
        return ForwardGetAsync(url);
    }

    [HttpGet("domain")]
    public Task<IActionResult> GetDomains()
        => ForwardGetAsync($"{LoliaFrpApiBaseUrl}/user/domain");

    [HttpPost("domain")]
    public async Task<IActionResult> AddDomain([FromBody] JToken body)
    {
        var response = await GeneralApi.PostAsync(
            $"{LoliaFrpApiBaseUrl}/user/domain",
            HttpService.PostContentType.Json,
            body,
            BuildProxyHeaders());

        return BuildActionResult(response);
    }

    [HttpPost("domain/verify")]
    public async Task<IActionResult> VerifyDomain([FromBody] JToken body)
    {
        var response = await GeneralApi.PostAsync(
            $"{LoliaFrpApiBaseUrl}/user/domain/verify",
            HttpService.PostContentType.Json,
            body,
            BuildProxyHeaders());

        return BuildActionResult(response);
    }

    [HttpDelete("domain/{domainId}")]
    public Task<IActionResult> DeleteDomain(string domainId)
        => ForwardDeleteAsync($"{LoliaFrpApiBaseUrl}/user/domain/{Uri.EscapeDataString(domainId)}");

    [HttpGet("traffic/daily")]
    public Task<IActionResult> GetDailyTraffic([FromQuery] string? days)
    {
        var url = $"{LoliaFrpApiBaseUrl}/user/traffic/daily";
        if (!string.IsNullOrEmpty(days)) url += $"?days={Uri.EscapeDataString(days)}";
        return ForwardGetAsync(url);
    }

    [HttpGet("traffic/tunnels")]
    public Task<IActionResult> GetTunnelsTraffic([FromQuery] string? days)
    {
        var url = $"{LoliaFrpApiBaseUrl}/user/traffic/tunnels";
        if (!string.IsNullOrEmpty(days)) url += $"?days={Uri.EscapeDataString(days)}";
        return ForwardGetAsync(url);
    }

    private async Task<IActionResult> ForwardGetAsync(string url)
    {
        var response = await GeneralApi.GetAsync(url, headers: BuildProxyHeaders());
        return BuildActionResult(response);
    }

    private async Task<IActionResult> ForwardPostAsync(string url, JToken? body)
    {
        var response = await GeneralApi.PostAsync(
            url,
            HttpService.PostContentType.Json,
            body,
            BuildProxyHeaders());

        return BuildActionResult(response);
    }

    private async Task<IActionResult> ForwardDeleteAsync(string url)
    {
        var response = await GeneralApi.GetAsync(url, headers: BuildProxyHeaders());
        return BuildActionResult(response);
    }

    private Dictionary<string, string> BuildProxyHeaders()
    {
        var headers = new Dictionary<string, string>();
        if (Request.Headers.TryGetValue("X-Loliafrp-Authorization", out StringValues authorization)
            && !StringValues.IsNullOrEmpty(authorization))
        {
            headers["Authorization"] = authorization.ToString();
        }
        return headers;
    }

    private IActionResult BuildActionResult(HttpService.HttpResponse response)
    {
        var contentData = ParseResponseContent(response.Content);

        if (response.IsSuccessStatusCode)
        {
            return Ok(new ApiResponse<object?>
            {
                Code = 200,
                Message = "请求成功",
                Data = contentData
            });
        }

        var statusCode = response.StatusCode > 0 ? response.StatusCode : 502;
        return StatusCode(statusCode, new ApiResponse<object?>
        {
            Code = statusCode,
            Message = ExtractErrorMessage(contentData, response.ResponseException),
            Data = contentData
        });
    }

    private static object? ParseResponseContent(string? content)
    {
        if (string.IsNullOrWhiteSpace(content)) return null;

        try
        {
            return JToken.Parse(content);
        }
        catch
        {
            return content;
        }
    }

    private static string ExtractErrorMessage(object? parsedContent, object? responseException)
    {
        if (parsedContent is JToken token)
        {
            var message = token["msg"]?.ToString()
                          ?? token["message"]?.ToString()
                          ?? token["error_description"]?.ToString()
                          ?? token["error"]?.ToString();

            if (!string.IsNullOrWhiteSpace(message)) return message;
        }
        else if (parsedContent is string str && !string.IsNullOrWhiteSpace(str))
        {
            return str;
        }

        return responseException?.ToString() ?? "请求失败";
    }
}