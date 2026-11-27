export interface WebAccountStatusSnapshot {
  connected: boolean;
  connectorState?: string;
  calibrated?: boolean;
}

export interface WebChannelPresentation {
  badgeVariant: 'success' | 'warning' | 'error' | 'secondary';
  stateLabel: string;
  headline: string;
  summaryText: string;
  calibrationLabel: string;
  showUncalibratedAlert: boolean;
  showUnknownCalibration: boolean;
  showStatusErrorAlert: boolean;
}

const nonRunningConnectorStates = new Set([
  'CLOSED',
  'DISCONNECTED',
  'UNAVAILABLE',
  'OPEN_UNVERIFIED',
  'ACCOUNT_CHANGED',
  'ERROR',
  'LOGIN_RECOVERY',
  'MANUAL_VISIBLE',
]);

export function resolveWebChannelPresentation({
  emergencyStopped,
  platformName,
  webStatus,
  statusReadError,
  accountStatus,
}: {
  emergencyStopped: boolean;
  platformName: string;
  webStatus: WebAccountStatusSnapshot | null;
  statusReadError: boolean;
  accountStatus?: 'ACTIVE' | 'DISCONNECTED' | 'PAUSED' | 'ERROR' | undefined;
}): WebChannelPresentation {
  if (statusReadError) {
    return {
      badgeVariant: 'warning',
      stateLabel: '状态读取失败',
      headline: '运行状态待核验',
      summaryText: '暂未能读取当前通道状态，请刷新后重试',
      calibrationLabel: '状态待核验（请刷新）',
      showUncalibratedAlert: false,
      showUnknownCalibration: false,
      showStatusErrorAlert: true,
    };
  }

  if (!webStatus) {
    return {
      badgeVariant: 'secondary',
      stateLabel: '读取中',
      headline: '正在核验通道状态',
      summaryText: '正在读取通道校准与运行状态…',
      calibrationLabel: '状态读取中…',
      showUncalibratedAlert: false,
      showUnknownCalibration: false,
      showStatusErrorAlert: false,
    };
  }

  const calibrated = webStatus.calibrated === true;
  const calibrationUnknown = webStatus.calibrated === undefined;
  const calibrationLabel = calibrated
    ? '已完成安全校准'
    : calibrationUnknown
      ? '校准状态未知'
      : '未校准真实页 · 仅离线验证禁发';
  const showUncalibratedAlert = webStatus.calibrated === false;
  const showUnknownCalibration = calibrationUnknown;

  if (emergencyStopped) {
    return {
      badgeVariant: 'error',
      stateLabel: '已急停',
      headline: '全局急停生效中',
      summaryText: `全局急停生效中，${platformName}通道已暂停`,
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  const state = webStatus.connectorState;
  if (state === 'CLOSING') {
    return {
      badgeVariant: 'warning',
      stateLabel: '正在关闭',
      headline: '关闭中',
      summaryText: `${platformName}专属浏览器正在安全关闭，完成前暂不可重新启用`,
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (state === 'CLOSED') {
    return {
      badgeVariant: calibrated ? 'secondary' : 'warning',
      stateLabel: calibrated ? '已关闭' : calibrationUnknown ? '已关闭 · 校准待核验' : '未校准 · 已关闭',
      headline: '浏览器未运行',
      summaryText: calibrated
        ? `${platformName}专属浏览器已关闭，未在后台运行`
        : calibrationUnknown
          ? `${platformName}专属浏览器已关闭，真实页面校准状态未知`
          : '未校准真实页 · 仅离线验证禁发（浏览器已关闭）',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (state === 'DISCONNECTED' || accountStatus === 'DISCONNECTED') {
    return {
      badgeVariant: 'secondary',
      stateLabel: '未连接',
      headline: '通道已断开',
      summaryText: calibrationUnknown
        ? '当前账号已断开连接，校准状态未知'
        : '当前账号已断开连接，未在后台运行',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (state === 'UNAVAILABLE') {
    return {
      badgeVariant: 'warning',
      stateLabel: '暂不可用',
      headline: '通道未就绪',
      summaryText: '通道运行实例暂不可用，请刷新或重新启用账号',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (state === 'OPEN_UNVERIFIED') {
    return {
      badgeVariant: 'warning',
      stateLabel: '已打开 · 待身份核验',
      headline: '等待账号核验',
      summaryText: calibrated
        ? `${platformName}专属浏览器已打开，但尚未完成账号身份核验`
        : calibrationUnknown
          ? `${platformName}专属浏览器已打开，身份与校准状态待核验`
          : '未校准真实页 · 仅离线验证禁发（账号身份待核验）',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (state === 'ACCOUNT_CHANGED') {
    return {
      badgeVariant: 'error',
      stateLabel: '账号不一致',
      headline: '已停止同步',
      summaryText: '检测到浏览器当前账号与绑定账号不一致，已停止运行',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (state === 'ERROR' || accountStatus === 'ERROR') {
    return {
      badgeVariant: 'error',
      stateLabel: '通道异常',
      headline: '通道异常',
      summaryText: '通道运行异常，请刷新状态或核对环境',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (state === 'LOGIN_RECOVERY' || state === 'MANUAL_VISIBLE') {
    return {
      badgeVariant: 'warning',
      stateLabel: '等待人工处理',
      headline: '需要本人处理',
      summaryText: '正在等待登录或安全验证，后台自动回复已暂停',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  if (webStatus.connected && (!state || !nonRunningConnectorStates.has(state))) {
    if (calibrated) {
      return {
        badgeVariant: 'success',
        stateLabel: '后台静音运行',
        headline: '后台静音运行',
        summaryText: `${platformName}专属浏览器后台静音运行中`,
        calibrationLabel,
        showUncalibratedAlert: false,
        showUnknownCalibration: false,
        showStatusErrorAlert: false,
      };
    }
    return {
      badgeVariant: 'warning',
      stateLabel: calibrationUnknown ? '校准待核验' : '未校准 · 禁发',
      headline: calibrationUnknown ? '校准状态未知' : '未校准真实页',
      summaryText: calibrationUnknown
        ? '通道已打开，真实页面安全校准状态待核验'
        : '未校准真实页 · 仅离线验证禁发',
      calibrationLabel,
      showUncalibratedAlert,
      showUnknownCalibration,
      showStatusErrorAlert: false,
    };
  }

  return {
    badgeVariant: 'warning',
    stateLabel: calibrated ? '待连接' : calibrationUnknown ? '未连接 · 校准待核验' : '未校准 · 未连接',
    headline: '未连接',
    summaryText: calibrated
      ? `${platformName}已完成安全校准，当前尚未连接运行`
      : calibrationUnknown
        ? '通道尚未连接，校准状态未知'
        : '未校准真实页 · 仅离线验证禁发（尚未连接）',
    calibrationLabel,
    showUncalibratedAlert,
    showUnknownCalibration,
    showStatusErrorAlert: false,
  };
}
