import {
  Archive,
  ArchiveRestore,
  Ban,
  Bookmark,
  BookmarkMinus,
  CircleMinus,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus2,
  Flag,
  Info,
  LockKeyhole,
  MessageCircle,
  Pencil,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  UserRoundX,
  Wand2,
  type LucideIcon,
} from 'lucide-react-native';

import { ShareGlyph } from '@/lib/platform-glyphs';

/**
 * The Lucide icon Android's menu draws for each SF Symbol a row names
 * (`systemImage` in `lib/native-menu.ts`): the same icons the sheets drew for
 * these actions (`components/viewer-action-sheet.tsx`), so an action keeps one
 * picture on every surface. A row names its icon once, as a symbol, and iOS
 * hands that name to the system.
 *
 * `__tests__/native-menu-icons.test.ts` fails a menu that names a symbol with
 * no icon here, so a new row cannot reach Android bare.
 */
export const NATIVE_MENU_ICONS: Readonly<Record<string, LucideIcon>> = {
  bookmark: Bookmark,
  'bookmark.slash': BookmarkMinus,
  'bubble.right': MessageCircle,
  'square.and.arrow.up': ShareGlyph,
  'wand.and.stars': Wand2,
  lock: LockKeyhole,
  'doc.badge.plus': FilePlus2,
  archivebox: Archive,
  'tray.and.arrow.up': ArchiveRestore,
  trash: Trash2,
  'minus.circle': CircleMinus,
  pencil: Pencil,
  eye: Eye,
  'arrow.up.right.square': ExternalLink,
  'slider.horizontal.3': SlidersHorizontal,
  'info.circle': Info,
  'arrow.down.circle': Download,
  'eye.slash': EyeOff,
  'person.crop.circle.badge.xmark': UserRoundX,
  flag: Flag,
  'exclamationmark.shield': ShieldAlert,
  nosign: Ban,
};

export function nativeMenuIcon(systemImage: string | undefined): LucideIcon | undefined {
  return systemImage ? NATIVE_MENU_ICONS[systemImage] : undefined;
}
