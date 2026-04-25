<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import {
  clearStoredLoliaFrpUser,
  createLoliaFrpTunnel,
  deleteLoliaFrpTunnel,
  fetchLoliaFrpNodes,
  fetchLoliaFrpTunnels,
  fetchLoliaFrpUserInfo,
  fetchLoliaFrpTrafficStats,
  getLoliaFrpFrpcConfig,
  getStoredLoliaFrpUser,
  openAuthorizationPage,
  saveStoredLoliaFrpUser,
  startAuthorization,
  type LoliaFrpUser,
  type LoliaFrpTunnel,
  type StoredLoliaFrpUser,
} from './auth';
import CreateTunnelDialog from '@/pages/frp/createFrp/components/CreateTunnelDialog.vue';
import { createFrpTunnel } from '@/pages/frp/createFrp/utils/create';
import { UserCircleIcon, ServerIcon, CloudIcon, AddIcon, RefreshIcon } from 'tdesign-icons-vue-next';

const showCreateDialog = ref(false);
const loliaUser = ref<StoredLoliaFrpUser | null>(null);

const loading = ref(false);
const userInfo = ref<LoliaFrpUser | null>(null);
const tunnels = ref<LoliaFrpTunnel[]>([]);
const selectedTunnelId = ref<number | null>(null);
const trafficInfo = ref<{ traffic_limit: number; traffic_used: number; traffic_remaining: number } | null>(null);

const isAuthorizing = ref(false);
const authMessage = ref('点击下方按钮进行授权登录');
const authError = ref('');
const popupWindow = ref<Window | null>(null);

let authCheckInterval: number | null = null;
let authWindowCheckInterval: number | null = null;

const currentTunnel = computed(() => {
  return tunnels.value.find((t) => t.id === selectedTunnelId.value) || null;
});

const hasLoliaAuth = computed(() => {
  return Boolean(loliaUser.value?.accessToken);
});

onMounted(() => {
  const storedUser = getStoredLoliaFrpUser();
  if (storedUser) {
    loliaUser.value = storedUser;
    void initDashboardData(false);
  }
});

onBeforeUnmount(() => {
  stopAuthCheck();
  if (popupWindow.value && !popupWindow.value.closed) {
    popupWindow.value.close();
  }
});

function stopAuthCheck() {
  if (authCheckInterval !== null) {
    window.clearInterval(authCheckInterval);
    authCheckInterval = null;
  }
  if (authWindowCheckInterval !== null) {
    window.clearInterval(authWindowCheckInterval);
    authWindowCheckInterval = null;
  }
}

function resetAuthorizationState() {
  stopAuthCheck();
  authMessage.value = '点击下方按钮进行授权登录';
  authError.value = '';
  isAuthorizing.value = false;
}

async function startAuth() {
  resetAuthorizationState();
  isAuthorizing.value = true;
  authMessage.value = '正在打开授权页面...';

  try {
    const { url } = await startAuthorization();
    popupWindow.value = await openAuthorizationPage();

    if (!popupWindow.value) {
      authError.value = '无法打开授权页面，请检查浏览器设置';
      isAuthorizing.value = false;
      return;
    }

    authMessage.value = '请在弹出的窗口中完成授权';

    const callbackUrl = 'http://localhost:56721/callback';
    const authCompleted = await checkAuthCallback(callbackUrl);

    if (authCompleted) {
      const storedUser = getStoredLoliaFrpUser();
      if (storedUser) {
        loliaUser.value = storedUser;
        resetAuthorizationState();
        const loaded = await initDashboardData();
        if (loaded) {
          MessagePlugin.success('LoliaFrp 授权登录成功');
        }
      }
    }
  } catch (e: any) {
    authError.value = e?.message || '授权失败，请稍后重试';
  } finally {
    isAuthorizing.value = false;
  }
}

async function checkAuthCallback(callbackUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 120;

    authCheckInterval = window.setInterval(async () => {
      attempts++;

      if (attempts > maxAttempts) {
        stopAuthCheck();
        authError.value = '授权超时，请重试';
        resolve(false);
        return;
      }

      if (!popupWindow.value || popupWindow.value.closed) {
        stopAuthCheck();
        authError.value = '授权窗口已关闭';
        resolve(false);
        return;
      }

      try {
        const response = await fetch(callbackUrl, { method: 'GET', cache: 'no-store' });
        if (response.ok) {
          const text = await response.text();
          if (text.includes('auth_success') || text.includes('error=')) {
            stopAuthCheck();
            popupWindow.value?.close();

            const storedUser = getStoredLoliaFrpUser();
            if (storedUser) {
              resolve(true);
            } else {
              authError.value = '授权失败，请重试';
              resolve(false);
            }
          }
        }
      } catch {
        // callback 不可用，继续轮询
      }
    }, 1000);
  });
}

async function initDashboardData(showFailureMessage = true) {
  loading.value = true;
  try {
    const [nextUserInfo, nextTunnels, nextTraffic] = await Promise.all([
      fetchLoliaFrpUserInfo(),
      fetchLoliaFrpTunnels(),
      fetchLoliaFrpTrafficStats().catch(() => null),
    ]);

    userInfo.value = nextUserInfo;
    tunnels.value = nextTunnels.list || [];
    trafficInfo.value = nextTraffic;

    if (loliaUser.value) {
      loliaUser.value.user = nextUserInfo;
      saveStoredLoliaFrpUser(loliaUser.value);
    }

    if (tunnels.value.length === 0) {
      selectedTunnelId.value = null;
    } else if (!tunnels.value.some((item) => item.id === selectedTunnelId.value)) {
      selectedTunnelId.value = tunnels.value[0].id;
    }

    return true;
  } catch (e: any) {
    const errorMsg = e?.response?.data?.msg || e?.msg || e?.message || '授权已失效或网络异常';
    if (showFailureMessage) {
      MessagePlugin.error(`LoliaFrp 数据加载失败：${errorMsg}`);
    }
    handleLogout(false);
    return false;
  } finally {
    loading.value = false;
  }
}

const isAddingTunnel = ref(false);

async function handleUseTunnel() {
  if (!currentTunnel.value) return;
  isAddingTunnel.value = true;

  try {
    const configText = await getLoliaFrpFrpcConfig(currentTunnel.value.tunnel_token);
    const tunnelName = `${currentTunnel.value.name} | ${currentTunnel.value.node_name || currentTunnel.value.node_id}`;

    await createFrpTunnel(tunnelName, configText, 'LoliaFrp', 'toml');
    MessagePlugin.success('配置文件已成功加载');
  } catch (e: any) {
    const errorMsg = e?.response?.data?.msg || e?.msg || e?.message || '未知错误';
    MessagePlugin.error(`获取配置异常: ${errorMsg}`);
  } finally {
    isAddingTunnel.value = false;
  }
}

const handleAddTunnel = () => {
  showCreateDialog.value = true;
};

function handleLogout(showMessage = true) {
  resetAuthorizationState();
  loliaUser.value = null;
  userInfo.value = null;
  tunnels.value = [];
  selectedTunnelId.value = null;
  trafficInfo.value = null;
  clearStoredLoliaFrpUser();
  if (showMessage) {
    MessagePlugin.success('已断开 LoliaFrp 授权');
  }
}

function handleLogoutConfirm() {
  handleLogout();
}

async function handleRefresh() {
  const loaded = await initDashboardData();
  if (loaded) {
    MessagePlugin.success('数据已更新');
  }
}

const isDeleting = ref(false);
async function handleDeleteTunnel() {
  if (!currentTunnel.value) return;
  isDeleting.value = true;

  try {
    const res: any = await deleteLoliaFrpTunnel(currentTunnel.value.name);

    if (res && res.code && res.code !== 200) {
      throw new Error(res.msg || '删除失败');
    }

    MessagePlugin.success('隧道删除成功');
    selectedTunnelId.value = null;
    await initDashboardData();
  } catch (e: any) {
    const errorMsg = e.message || e.response?.data?.msg || e.msg || '未知错误';
    MessagePlugin.error(`删除失败: ${errorMsg}`);
  } finally {
    isDeleting.value = false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
</script>

<template>
  <div class="mx-auto pb-6 text-[var(--td-text-color-primary)]">
    <div v-if="!hasLoliaAuth" class="flex items-center justify-center min-h-[70vh] list-item-anim">
      <div
        class="design-card relative w-full max-w-md bg-[var(--td-bg-color-container)]/80 rounded-3xl border border-[var(--td-component-border)] shadow-xl p-10 text-center overflow-hidden"
      >
        <div
          class="absolute -top-20 -right-20 w-60 h-60 bg-[var(--color-primary)]/10 rounded-full blur-3xl pointer-events-none"
        ></div>
        <div
          class="absolute -bottom-10 -left-10 w-40 h-40 bg-[var(--color-primary)]/10 rounded-full blur-3xl pointer-events-none"
        ></div>

        <div class="relative z-10 flex flex-col items-center">
          <div
            class="w-20 h-20 bg-[var(--color-primary)]/10 rounded-2xl flex items-center justify-center mb-6 shadow-sm border border-[var(--color-primary)]/20 overflow-hidden p-2"
          >
            <img src="https://lolia.link/favicon.ico" alt="logo" class="w-full h-full object-contain" />
          </div>
          <h2 class="text-2xl font-extrabold text-[var(--td-text-color-primary)] !mb-2 tracking-tight">登录 LoliaFrp</h2>
          <p class="text-sm text-[var(--td-text-color-secondary)] !mb-6 font-medium">
            使用浏览器完成官方授权，MSLX 会自动同步您的 LoliaFrp 账户
          </p>

          <t-button
            block
            theme="primary"
            size="large"
            :loading="isAuthorizing"
            class="!rounded-xl !h-12 !font-bold shadow-md shadow-[var(--color-primary-light)]/30 hover:shadow-[var(--color-primary-light)]/50"
            @click="startAuth"
          >
            <template #icon><user-circle-icon /></template>
            授权登录
          </t-button>

          <div
            v-if="authMessage && !authError"
            class="mt-4 w-full rounded-2xl border border-[var(--td-component-border)] bg-[var(--td-bg-color-secondarycontainer)]/70 px-4 py-3 text-sm text-[var(--td-text-color-secondary)]"
          >
            {{ authMessage }}
          </div>

          <div
            v-if="authError"
            class="mt-4 w-full rounded-2xl border border-red-200/80 bg-red-50/80 px-4 py-3 text-sm text-red-500 dark:border-red-900/60 dark:bg-red-950/20"
          >
            {{ authError }}
          </div>
        </div>
      </div>
    </div>

    <div v-else id="app-space" class="relative flex flex-col gap-6">
      <t-loading attach="#app-space" :loading="loading" text="加载数据中..." />

      <div
        v-if="userInfo"
        class="design-card list-item-anim bg-[var(--td-bg-color-container)]/80 rounded-2xl border border-[var(--td-component-border)] shadow-sm p-5 sm:p-6"
        style="animation-delay: 0s"
      >
        <div
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-dashed border-zinc-200/70 dark:border-zinc-700/60"
        >
          <div class="flex items-center gap-3">
            <t-avatar :image="userInfo.avatar" size="medium" shape="round" />
            <div class="flex flex-col">
              <h3 class="text-lg font-bold text-[var(--td-text-color-primary)] m-0 leading-none">LoliaFrp 账户</h3>
              <span class="text-xs text-zinc-500 mt-1">{{ userInfo.email }}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <t-tag
              v-if="userInfo.has_kyc"
              theme="success"
              variant="light-outline"
              class="!rounded-md !font-bold"
              >已实名</t-tag
            >
            <t-tag theme="primary" variant="light-outline" class="!rounded-md !font-bold">{{
              userInfo.role
            }}</t-tag>
            <div class="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1"></div>
            <t-popconfirm content="确认断开 LoliaFrp 的连接吗？" @confirm="handleLogoutConfirm">
              <t-button variant="text" theme="danger" size="small" class="!rounded-lg hover:!bg-red-500/10"
                >退出登录</t-button
              >
            </t-popconfirm>
          </div>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div
            class="p-4 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800 transition-colors hover:bg-white dark:hover:bg-zinc-800"
          >
            <div
              class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1"
            >
              用户名称
            </div>
            <div class="text-lg font-bold text-[var(--td-text-color-primary)] truncate">{{ userInfo.username }}</div>
          </div>

          <div
            class="p-4 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800 transition-colors hover:bg-white dark:hover:bg-zinc-800"
          >
            <div
              class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1"
            >
              隧道配额
            </div>
            <div class="text-lg font-bold text-[var(--td-text-color-primary)] font-mono">
              <span class="text-[var(--color-primary)]">{{ tunnels.length }}</span> / {{ userInfo.max_tunnel_count }}
              <span class="text-sm font-medium text-zinc-500">条</span>
            </div>
          </div>

          <div
            class="p-4 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800 transition-colors hover:bg-white dark:hover:bg-zinc-800"
          >
            <div
              class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1"
            >
              带宽限制
            </div>
            <div class="text-lg font-bold text-[var(--td-text-color-primary)] font-mono">
              {{ userInfo.bandwidth_limit }} <span class="text-sm font-medium text-zinc-500">Mbps</span>
            </div>
          </div>

          <div
            v-if="trafficInfo"
            class="p-4 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/50 border border-zinc-100 dark:border-zinc-800 transition-colors hover:bg-white dark:hover:bg-zinc-800"
          >
            <div
              class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1"
            >
              流量使用
            </div>
            <div class="text-[15px] font-bold text-[var(--color-warning)] font-mono mt-0.5">
              {{ formatBytes(trafficInfo.traffic_used) }} / {{ formatBytes(trafficInfo.traffic_limit) }}
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div
          class="lg:col-span-5 xl:col-span-4 design-card list-item-anim flex flex-col bg-[var(--td-bg-color-container)]/80 rounded-2xl border border-[var(--td-component-border)] shadow-sm h-[580px]"
          style="animation-delay: 0.1s"
        >
          <div
            class="flex items-center justify-between p-4 sm:p-5 border-b border-dashed border-zinc-200/70 dark:border-zinc-700/60 shrink-0"
          >
            <h3 class="text-base font-bold text-[var(--td-text-color-primary)] m-0">我的隧道</h3>
            <div class="flex items-center gap-1">
              <t-button
                size="small"
                variant="text"
                class="!px-2 hover:!bg-zinc-100 dark:hover:!bg-zinc-700/50"
                :loading="loading"
                @click="handleRefresh"
              >
                <template #icon><refresh-icon /></template>刷新
              </t-button>
              <t-button size="small" theme="primary" class="!px-3 !ml-1 !rounded-lg" @click="handleAddTunnel">
                <template #icon><add-icon /></template>新建
              </t-button>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto custom-scrollbar p-3">
            <div v-if="tunnels.length > 0" class="flex flex-col gap-2">
              <div
                v-for="tunnel in tunnels"
                :key="tunnel.id"
                class="group flex items-center p-3 rounded-xl cursor-pointer transition-all duration-300 border"
                :class="
                  selectedTunnelId === tunnel.id
                    ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]/30 shadow-sm'
                    : 'bg-transparent border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-700/50 hover:border-zinc-200 dark:hover:border-zinc-600'
                "
                @click="selectedTunnelId = tunnel.id"
              >
                <div
                  class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mr-3 transition-colors"
                  :class="
                    selectedTunnelId === tunnel.id
                      ? 'bg-[var(--color-primary)] text-white shadow-md shadow-[var(--color-primary)]/30'
                      : 'bg-zinc-100 dark:bg-zinc-900 text-[var(--td-text-color-secondary)] group-hover:text-zinc-800 dark:group-hover:text-zinc-200'
                  "
                >
                  <server-icon size="20px" />
                </div>
                <div class="flex-1 min-w-0 mr-3">
                  <div
                    class="font-bold text-sm truncate transition-colors"
                    :class="
                      selectedTunnelId === tunnel.id
                        ? 'text-[var(--color-primary)]'
                        : 'text-[var(--td-text-color-primary)]'
                    "
                  >
                    {{ tunnel.name }}
                  </div>
                  <div class="text-[11px] text-[var(--td-text-color-secondary)] truncate mt-0.5">
                    {{ tunnel.node_name || `节点 ${tunnel.node_id}` }}
                  </div>
                </div>
                <div class="shrink-0">
                  <t-tag
                    v-if="tunnel.status === 'online' || tunnel.status === 'running'"
                    theme="success"
                    variant="light"
                    size="small"
                    class="!rounded !font-bold !px-1.5"
                    >在线</t-tag
                  >
                  <t-tag
                    v-else
                    theme="default"
                    variant="light"
                    size="small"
                    class="!rounded !font-bold !px-1.5 !text-zinc-500"
                    >离线</t-tag
                  >
                </div>
              </div>
            </div>

            <div v-else class="h-full flex flex-col items-center justify-center opacity-60">
              <server-icon size="32px" class="text-zinc-400 mb-2" />
              <span class="text-sm text-zinc-500 font-medium">暂无隧道，请先新建</span>
            </div>
          </div>
        </div>

        <div
          class="lg:col-span-7 xl:col-span-8 design-card list-item-anim flex flex-col bg-[var(--td-bg-color-container)]/80 rounded-2xl border border-[var(--td-component-border)] shadow-sm h-[580px]"
          style="animation-delay: 0.2s"
        >
          <template v-if="currentTunnel">
            <div
              class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 sm:p-6 border-b border-dashed border-zinc-200/70 dark:border-zinc-700/60 shrink-0"
            >
              <div class="flex flex-col min-w-0">
                <h3 class="text-xl font-extrabold text-[var(--td-text-color-primary)] m-0 truncate">
                  {{ currentTunnel.name }}
                </h3>
                <p
                  class="text-xs text-[var(--td-text-color-secondary)] mt-1 truncate font-mono bg-zinc-100 dark:bg-zinc-800/50 w-max px-2 py-0.5 rounded"
                >
                  ID: {{ currentTunnel.id }}
                </p>
              </div>
              <div class="shrink-0">
                <t-popconfirm
                  content="确认删除此隧道吗？将无法恢复！"
                  theme="danger"
                  placement="bottom-right"
                  @confirm="handleDeleteTunnel"
                >
                  <t-button
                    theme="danger"
                    class="!rounded-lg hover:!bg-red-500 hover:!text-white transition-colors"
                    :loading="isDeleting"
                  >
                    <template #icon><t-icon name="delete" /></template>
                    删除隧道
                  </t-button>
                </t-popconfirm>
              </div>
            </div>

            <div class="flex-1 overflow-y-auto custom-scrollbar p-5 sm:p-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4">
                <div
                  class="p-4 bg-zinc-50/80 dark:bg-zinc-900/50 rounded-xl border border-[var(--td-component-border)] flex flex-col justify-center"
                >
                  <span
                    class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1.5"
                    >所在节点</span
                  >
                  <span
                    class="text-sm font-bold text-[var(--td-text-color-primary)] truncate"
                    :title="currentTunnel.node_name"
                    >{{ currentTunnel.node_name || `节点 ${currentTunnel.node_id}` }}</span
                  >
                </div>

                <div
                  class="p-4 bg-zinc-50/80 dark:bg-zinc-900/50 rounded-xl border border-[var(--td-component-border)] flex flex-col justify-center"
                >
                  <span
                    class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1.5"
                    >本地地址</span
                  >
                  <span class="text-sm font-mono font-bold text-[var(--td-text-color-primary)]"
                    >{{ currentTunnel.local_ip }}:{{ currentTunnel.local_port }}</span
                  >
                </div>

                <div
                  class="p-4 bg-emerald-50/50 dark:bg-emerald-900/20 rounded-xl border border-emerald-200/50 dark:border-emerald-800/30 flex flex-col justify-center"
                >
                  <span
                    class="text-[11px] font-extrabold text-emerald-600/80 dark:text-emerald-500/80 uppercase tracking-widest mb-1.5"
                    >远程信息</span
                  >
                  <span class="text-lg font-mono font-extrabold text-emerald-600 dark:text-emerald-400">
                    {{ currentTunnel.type }}:{{ currentTunnel.remote_port }}
                  </span>
                </div>

                <div
                  class="p-4 rounded-xl flex flex-col justify-center border transition-colors"
                  :class="
                    currentTunnel.status === 'online' || currentTunnel.status === 'running'
                      ? 'bg-emerald-50/50 dark:bg-emerald-900/10 border-emerald-200/50 dark:border-emerald-800/30'
                      : 'bg-zinc-50/80 dark:bg-zinc-900/50 border-[var(--td-component-border)]'
                  "
                >
                  <span
                    class="text-[11px] font-extrabold uppercase tracking-widest mb-1.5"
                    :class="
                      currentTunnel.status === 'online' || currentTunnel.status === 'running'
                        ? 'text-emerald-600/80 dark:text-emerald-500/80'
                        : 'text-[var(--td-text-color-secondary)]'
                    "
                    >当前状态</span
                  >
                  <div class="flex items-center gap-2">
                    <span
                      v-if="currentTunnel.status === 'online' || currentTunnel.status === 'running'"
                      class="w-2 h-2 rounded-full bg-[var(--color-success)] animate-pulse"
                    ></span>
                    <span
                      class="text-sm font-bold"
                      :class="
                        currentTunnel.status === 'online' || currentTunnel.status === 'running'
                          ? 'text-[var(--color-success)]'
                          : 'text-zinc-500'
                      "
                    >
                      {{ currentTunnel.status === 'online' || currentTunnel.status === 'running' ? '在线' : '离线' }}
                    </span>
                  </div>
                </div>

                <div
                  v-if="currentTunnel.custom_domain"
                  class="p-4 bg-zinc-50/80 dark:bg-zinc-900/50 rounded-xl border border-[var(--td-component-border)] flex flex-col justify-center"
                >
                  <span
                    class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1.5"
                    >自定义域名</span
                  >
                  <span class="text-sm font-bold text-[var(--td-text-color-primary)] truncate">{{
                    currentTunnel.custom_domain
                  }}</span>
                </div>

                <div
                  class="p-4 bg-zinc-50/80 dark:bg-zinc-900/50 rounded-xl border border-[var(--td-component-border)] flex flex-col justify-center"
                >
                  <span
                    class="text-[11px] font-extrabold text-[var(--td-text-color-secondary)] uppercase tracking-widest mb-1.5"
                    >备注</span
                  >
                  <span class="text-sm font-bold text-[var(--td-text-color-primary)] truncate">{{
                    currentTunnel.remark || '-'
                  }}</span>
                </div>
              </div>

              <div class="mt-8">
                <t-button
                  theme="primary"
                  size="large"
                  :loading="isAddingTunnel"
                  block
                  class="!rounded-xl !h-12 !font-bold shadow-md shadow-[var(--color-primary-light)]/40 hover:shadow-[var(--color-primary-light)]/60 transition-shadow text-base"
                  @click="handleUseTunnel"
                >
                  <template #icon><t-icon name="play-circle" /></template>
                  使用此隧道
                </t-button>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="flex-1 flex flex-col items-center justify-center opacity-50 p-6 text-center">
              <div class="w-24 h-24 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-4">
                <cloud-icon size="40px" class="text-zinc-400" />
              </div>
              <h3 class="text-base font-bold text-zinc-700 dark:text-zinc-300 mb-1">未选择隧道</h3>
              <p class="text-sm text-zinc-500">请在左侧列表中选择一个隧道以查看详细信息</p>
            </div>
          </template>
        </div>
      </div>
    </div>

    <create-tunnel-dialog v-if="showCreateDialog" v-model:visible="showCreateDialog" />
  </div>
</template>

<style scoped lang="less">
@import '@/style/scrollbar';

.list-item-anim {
  animation: slideUp 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes smoothLoadingGlass {
  from {
    backdrop-filter: blur(0.01px) !important;
    -webkit-backdrop-filter: blur(0.01px) !important;
  }
  to {
    backdrop-filter: blur(4px) !important;
    -webkit-backdrop-filter: blur(4px) !important;
  }
}

.custom-scrollbar {
  .scrollbar-mixin();
}

:deep(.t-loading__overlay) {
  border-radius: 1rem !important;
  background: rgb(255 255 255 / 50%) !important;
  animation: smoothLoadingGlass 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards !important;
}

:global(.dark) :deep(.t-loading__overlay) {
  background: rgb(24 24 27 / 50%) !important;
}
</style>