/**
 * 跨设备共享设置 / settings that travel with the vault
 *
 * `data.json` 住在插件目录里，而插件目录被自己的 .gitignore 排除 —— 于是每台设备各有一份设置：
 * 同一批数据，一台算「含脱离窗口」、另一台不算，面板上的数字就永远对不上。
 *
 * `data.json` lives in the plugin folder, and that folder ignores it — so every device keeps its
 * own settings. The same data then reads differently on each: one counts out-of-window time as
 * reading, the other does not, and the panels never agree.
 *
 * 这份文件把设置放进数据所在的目录（默认是 vault 内的 `Components/History/`），随 vault 一起同步。
 * 少数几项**必须留在本机**，否则设备会互相踢：数据文件路径、以及这个开关本身就是引导项 ——
 * 它们决定了去哪读/读不读共享文件，只能来自本机的 data.json。
 *
 * This file puts the settings beside the data (by default in the vault's `Components/History/`), so
 * they travel with the vault. A few keys **must stay local** or the devices kick each other around:
 * the data file path and this switch itself are bootstrap — they decide where to read and whether to
 * read at all, so they can only come from the local data.json.
 */

/**
 * 只需要文本读写这三个方法 / just the three text-file methods this module uses.
 *
 * 用窄接口而不是本项目的 DataAdapter：Obsidian 自己的 vault adapter 结构上就满足它，不必为了一个
 * 设置文件去包一层。
 * A narrow interface rather than this project's DataAdapter: Obsidian's own vault adapter matches
 * it structurally, so a settings file does not need a wrapper layer.
 */
export interface TextFileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

/** 只能来自本机的键 / the keys that only ever come from this device. */
export const DEVICE_LOCAL_KEYS = ['dataFilePath', 'perDeviceSettings', 'mobileMultiWindow'] as const;

/**
 * 共享设置的固定路径 / the shared file at a fixed path.
 *
 * **不能**跟着数据路径走：数据路径（dataFilePath）是本机引导键，两台设备一旦不同，就会去不同目录找
 * 共享文件，永远读不到对方写的那份 —— 那正好是「不同设备显示不同数据」本身。所以这里用 vault 里约定
 * 俗成的配置目录，与任何本机设置无关。
 *
 * It must **not** follow the data path: dataFilePath is a device-local bootstrap key, so two devices
 * with different values would look for the shared file in different places and never see each
 * other's copy — which is exactly the divergence this file exists to fix. So it lives in the vault's
 * conventional config folder, independent of any device setting.
 */
export const SHARED_SETTINGS_PATH = 'Components/Configs/rtt-settings.json';

/** 只保留本机引导键 / keep only the bootstrap keys from a raw settings object. */
export function pickDeviceLocal(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  const source = raw as Record<string, unknown>;
  for (const key of DEVICE_LOCAL_KEYS) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

/** 去掉本机引导键 / drop the bootstrap keys before writing the shared copy. */
export function withoutDeviceLocal(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  for (const key of DEVICE_LOCAL_KEYS) delete out[key];
  return out;
}

/**
 * 读共享设置 / read the shared settings.
 *
 * 文件不存在、解析失败、或内容不是对象，都当作「没有共享设置」——调用方于是继续用本机那份，
 * 不会因为一个坏文件把插件卡在启动不了的状态。
 *
 * A missing file, a parse error, or a payload that is not an object all mean "no shared settings";
 * the caller then keeps its own copy, so one bad file cannot leave the plugin unable to start.
 */
export async function readSharedSettings(
  adapter: TextFileAdapter,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    if (!(await adapter.exists(path))) return null;
    const parsed: unknown = JSON.parse(await adapter.read(path));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn('[RTT][settings] 共享设置读取失败 / failed to read shared settings:', error);
    return null;
  }
}

/** 写共享设置 / write the shared settings. */
export async function writeSharedSettings(
  adapter: TextFileAdapter,
  path: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await adapter.write(path, `${JSON.stringify(withoutDeviceLocal(settings), null, 2)}\n`);
}
