import type { Account } from './nimbus';

/** Capabilities describe the implemented provider operations, not connection health. */
export function storageCapabilities(provider: string) {
  return {
    copy: provider === 'local' || provider === 'baidu',
    createFolder: provider === 'local' || provider === 'baidu',
    textPreview: provider === 'local',
    openNative: provider === 'local',
  };
}
export function canCopyBetween(source: Account, destination: Account): boolean {
  return (source.provider === 'local' && ['local', 'baidu'].includes(destination.provider)) ||
    (source.provider === 'baidu' && (destination.provider === 'local' ||
      (destination.provider === 'baidu' && source.id === destination.id)));
}
export function validFolderName(name: string): boolean {
  const value = name.trim();
  return value.length > 0 && value !== '.' && value !== '..' && !/[\/\x00]/.test(value);
}
