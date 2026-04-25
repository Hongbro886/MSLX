import { request } from '@/utils/request';
import { openLoginPopup } from '@/utils/popup';

const API_BASE_URL = '/api/frp/loliafrp';
const STORAGE_KEY = 'loliafrp_user';
const OAUTH_AUTHORIZE_URL = 'https://dash.lolia.link/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://api.lolia.link/api/v1/oauth2/token';
const OAUTH_CLIENT_ID = 'goibzooz0s14ntgc';
const OAUTH_REDIRECT_URI = 'http://localhost:56721/callback';
const OAUTH_HEADER_NAME = 'X-Loliafrp-Authorization';

function generateRandomBase64Url(length: number): string {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export interface LoliaFrpUser {
  id: number;
  username: string;
  email: string;
  avatar: string;
  role: string;
  traffic_limit: number;
  traffic_used: number;
  bandwidth_limit: number;
  max_tunnel_count: number;
  created_at: string;
  has_kyc: boolean;
  kyc_status: string;
  is_baned: boolean;
  today_checked: boolean;
}

export interface LoliaFrpTunnel {
  id: number;
  name: string;
  node_id: number;
  node_name?: string;
  node_address?: string;
  type: string;
  local_ip: string;
  local_port: number;
  remote_port: number;
  custom_domain: string;
  bandwidth_limit: number;
  remark: string;
  status: string;
  tunnel_token?: string;
  created_at?: string;
  client_version?: string;
}

export interface LoliaFrpNode {
  id: number;
  name: string;
  status: string;
  ip_address: string;
  supported_protocols: string[];
  need_kyc: boolean;
  frps_version: string;
  agent_version: string;
  frps_port: number;
  sponsor: string;
  bandwidth: number;
  last_seen: string;
  created_at: string;
}

export interface StoredLoliaFrpUser {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  user: LoliaFrpUser | null;
}

interface PendingSession {
  codeVerifier: string;
  state: string;
}

let pendingSession: PendingSession | null = null;
let pollingTimer: number | null = null;

export function getStoredLoliaFrpUser(): StoredLoliaFrpUser | null {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const user = JSON.parse(saved) as StoredLoliaFrpUser;
      return user;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  return null;
}

export function saveStoredLoliaFrpUser(user: StoredLoliaFrpUser) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

export function clearStoredLoliaFrpUser() {
  localStorage.removeItem(STORAGE_KEY);
}

function isTokenExpiring(stored: StoredLoliaFrpUser | null): boolean {
  if (!stored?.expiresAt) return false;
  return Date.now() >= stored.expiresAt - 60_000;
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error('刷新令牌失败');
  }

  return response.json();
}

async function ensureAuthenticatedUser(): Promise<StoredLoliaFrpUser> {
  const storedUser = getStoredLoliaFrpUser();

  if (!storedUser?.accessToken) {
    throw new Error('登录信息已过期，请重新授权');
  }

  if (storedUser.refreshToken && isTokenExpiring(storedUser)) {
    try {
      const refreshed = await refreshAccessToken(storedUser.refreshToken);
      const updatedUser: StoredLoliaFrpUser = {
        ...storedUser,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || storedUser.refreshToken,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
        tokenType: refreshed.token_type || storedUser.tokenType || 'Bearer',
      };
      saveStoredLoliaFrpUser(updatedUser);
      return updatedUser;
    } catch {
      clearStoredLoliaFrpUser();
      throw new Error('登录信息已过期，请重新授权');
    }
  }

  return storedUser;
}

export async function getLoliaFrpAuthorizationHeader(): Promise<string> {
  const user = await ensureAuthenticatedUser();
  const token = user.accessToken;
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

async function getAuthorizationUrl(): Promise<{ url: string; codeVerifier: string; state: string }> {
  const codeVerifier = generateRandomBase64Url(32);
  const state = generateRandomBase64Url(32);

  pendingSession = { codeVerifier, state };

  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const codeChallenge = base64UrlEncode(hashBuffer);

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    scope: 'all',
    redirect_uri: OAUTH_REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    url: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    codeVerifier,
    state,
  };
}

async function exchangeCodeForToken(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}> {
  if (!pendingSession) {
    throw new Error('授权会话已过期，请重新开始');
  }

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code,
      code_verifier: pendingSession.codeVerifier,
      redirect_uri: OAUTH_REDIRECT_URI,
    }).toString(),
  });

  pendingSession = null;

  if (!response.ok) {
    throw new Error('获取访问令牌失败');
  }

  return response.json();
}

export async function startAuthorization(): Promise<{ url: string }> {
  const { url } = await getAuthorizationUrl();
  return { url };
}

export async function handleAuthCallback(code: string): Promise<StoredLoliaFrpUser> {
  const tokenResponse = await exchangeCodeForToken(code);

  const user: StoredLoliaFrpUser = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    tokenType: tokenResponse.token_type || 'Bearer',
    user: null,
  };

  saveStoredLoliaFrpUser(user);
  return user;
}

export async function openAuthorizationPage(): Promise<Window | null> {
  const { url } = await getAuthorizationUrl();
  return openLoginPopup(url, 'LoliaFrp 授权登录', 600, 700);
}

export async function fetchLoliaFrpUserInfo(): Promise<LoliaFrpUser> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  const response = await request.get({
    url: `${API_BASE_URL}/userinfo`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
  });

  const data = response?.data || response;
  if (data?.id) {
    return data;
  }
  throw new Error('获取用户信息失败');
}

export async function fetchLoliaFrpTunnels(page = '1', limit = '10'): Promise<{
  list: LoliaFrpTunnel[];
  total: number;
  page: number;
  total_page: number;
}> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  const response = await request.get({
    url: `${API_BASE_URL}/tunnel`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
    params: { page, limit },
  });

  const data = response?.data || response;
  if (data?.list) {
    return data;
  }
  throw new Error('获取隧道列表失败');
}

export async function fetchLoliaFrpNodes(): Promise<LoliaFrpNode[]> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  const response = await request.post({
    url: `${API_BASE_URL}/nodes`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
  });

  const data = response?.data || response;
  if (Array.isArray(data?.nodes)) {
    return data.nodes;
  }
  throw new Error('获取节点列表失败');
}

export async function createLoliaFrpTunnel(params: {
  node_id: number;
  type: string;
  local_ip: string;
  local_port: number;
  remote_port: number;
  custom_domain?: string;
  remark?: string;
}): Promise<any> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  return request.post({
    url: `${API_BASE_URL}/tunnel`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
    data: params,
  });
}

export async function deleteLoliaFrpTunnel(tunnelName: string): Promise<any> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  return request.post({
    url: `${API_BASE_URL}/tunnel/${encodeURIComponent(tunnelName)}`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
  });
}

export async function getLoliaFrpFrpcConfig(tunnel?: string): Promise<string> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  const params = tunnel ? { tunnel } : {};
  const response = await request.get({
    url: `${API_BASE_URL}/frpc-config`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
    params,
  });

  const data = response?.data || response;
  if (typeof data?.config === 'string') {
    return data.config;
  }
  throw new Error('获取配置失败');
}

export async function fetchLoliaFrpTrafficStats(): Promise<{
  traffic_limit: number;
  traffic_used: number;
  traffic_remaining: number;
}> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  const response = await request.get({
    url: `${API_BASE_URL}/traffic`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
  });

  const data = response?.data || response;
  if (data?.traffic_limit !== undefined) {
    return data;
  }
  throw new Error('获取流量统计失败');
}

export async function fetchLoliaFrpDomains(): Promise<any[]> {
  const authorization = await getLoliaFrpAuthorizationHeader();
  const response = await request.get({
    url: `${API_BASE_URL}/domain`,
    headers: { [OAUTH_HEADER_NAME]: authorization },
  });

  const data = response?.data || response;
  if (Array.isArray(data?.domains)) {
    return data.domains;
  }
  return [];
}