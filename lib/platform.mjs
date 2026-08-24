// OS判定と権限付与のOS差の唯一の置き場（現行世代のlib/bin用）。
// wire版別の凍結ファイル（lib/factory/v2〜v5.mjsとそのbin実行体）は互換凍結のため
// 既存実装のまま残し、本moduleへは寄せない。
import { chmod } from 'node:fs/promises';

export const isWin32 = () => process.platform === 'win32';

// POSIXだけmode bitsを強制する（WindowsはACLが別体系で、必要な箇所が自前のACL適用を持つ）。
export async function chmodIfPosix(path, mode) {
  if (!isWin32()) await chmod(path, mode);
}
