/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { MUSIC } from './definition.ts';

export default MUSIC;
export { MUSIC };
export type { MusicConfigSection } from './config.ts';
