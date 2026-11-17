import {
  ArrowLeftRightIcon,
  AstroidIcon,
  BarChart3Icon,
  CogIcon,
  DatabaseIcon,
  FileCogIcon,
  GaugeIcon,
  HeartHandshakeIcon,
  KeyIcon,
  KeyRoundIcon,
  type LucideIcon,
  MailIcon,
  Settings2Icon,
  SquarePenIcon,
  TagsIcon,
  UserIcon,
  UsersIcon,
  WebhookIcon,
} from "lucide-react";
import { type ComponentType } from "react";
import { InstanceSetting_Key } from "@/types/proto/api/instance_service_pb";
import { lazyWithReload } from "@/utils/lazy";

export type SettingSectionKey =
  | "my-account"
  | "memo-export"
  | "spaces"
  | "access-token"
  | "preference"
  | "editor"
  | "webhook"
  | "member"
  | "system"
  | "storage"
  | "usage-limits"
  | "notification"
  | "sso"
  | "tags"
  | "ai"
  | "resource-stats"
  | "configuration";

type SettingSectionScope = "basic" | "admin";

export interface SettingSectionDefinition {
  key: SettingSectionKey;
  scope: SettingSectionScope;
  labelKey: `setting.${SettingSectionKey}.label`;
  icon: LucideIcon;
  component: ComponentType;
  preloadSettingKeys?: InstanceSetting_Key[];
}

export const SETTINGS_SECTIONS: SettingSectionDefinition[] = [
  {
    key: "my-account",
    scope: "basic",
    labelKey: "setting.my-account.label",
    icon: UserIcon,
    component: lazyWithReload(() => import("@/components/Settings/MyAccountSection")),
  },
  {
    key: "spaces",
    scope: "basic",
    labelKey: "setting.spaces.label",
    icon: AstroidIcon,
    component: lazyWithReload(() => import("@/components/Settings/SpacesSection")),
  },
  {
    key: "access-token",
    scope: "basic",
    labelKey: "setting.access-token.label",
    icon: KeyRoundIcon,
    component: lazyWithReload(() => import("@/components/Settings/AccessTokenSection")),
  },
  {
    key: "preference",
    scope: "basic",
    labelKey: "setting.preference.label",
    icon: CogIcon,
    component: lazyWithReload(() => import("@/components/Settings/PreferencesSection")),
  },
  {
    key: "editor",
    scope: "basic",
    labelKey: "setting.editor.label",
    icon: SquarePenIcon,
    component: lazyWithReload(() => import("@/components/Settings/EditorSection")),
  },
  {
    key: "webhook",
    scope: "basic",
    labelKey: "setting.webhook.label",
    icon: WebhookIcon,
    component: lazyWithReload(() => import("@/components/Settings/WebhookSection")),
  },
  {
    key: "member",
    scope: "admin",
    labelKey: "setting.member.label",
    icon: UsersIcon,
    component: lazyWithReload(() => import("@/components/Settings/MemberSection")),
  },
  {
    key: "system",
    scope: "admin",
    labelKey: "setting.system.label",
    icon: Settings2Icon,
    component: lazyWithReload(() => import("@/components/Settings/InstanceSection")),
  },
  {
    key: "tags",
    scope: "basic",
    labelKey: "setting.tags.label",
    icon: TagsIcon,
    component: lazyWithReload(() => import("@/components/Settings/TagsSection")),
  },
  {
    key: "memo-export",
    scope: "basic",
    labelKey: "setting.memo-export.label",
    icon: ArrowLeftRightIcon,
    component: lazyWithReload(() => import("@/components/Settings/MemoExportSection")),
  },
  {
    key: "storage",
    scope: "admin",
    labelKey: "setting.storage.label",
    icon: DatabaseIcon,
    component: lazyWithReload(() => import("@/components/Settings/StorageSection")),
    preloadSettingKeys: [InstanceSetting_Key.STORAGE],
  },
  {
    key: "usage-limits",
    scope: "admin",
    labelKey: "setting.usage-limits.label",
    icon: GaugeIcon,
    component: lazyWithReload(() => import("@/components/Settings/UsageLimitsSection")),
  },
  {
    key: "notification",
    scope: "admin",
    labelKey: "setting.notification.label",
    icon: MailIcon,
    component: lazyWithReload(() => import("@/components/Settings/NotificationSection")),
    preloadSettingKeys: [InstanceSetting_Key.NOTIFICATION],
  },
  {
    key: "sso",
    scope: "admin",
    labelKey: "setting.sso.label",
    icon: KeyIcon,
    component: lazyWithReload(() => import("@/components/Settings/SSOSection")),
  },
  {
    key: "ai",
    scope: "admin",
    labelKey: "setting.ai.label",
    icon: HeartHandshakeIcon,
    component: lazyWithReload(() => import("@/components/Settings/AISection")),
    preloadSettingKeys: [InstanceSetting_Key.AI],
  },
  {
    key: "resource-stats",
    scope: "admin",
    labelKey: "setting.resource-stats.label",
    icon: BarChart3Icon,
    component: lazyWithReload(() => import("@/components/Settings/ResourceStatsSection")),
  },
  {
    key: "configuration",
    scope: "admin",
    labelKey: "setting.configuration.label",
    icon: FileCogIcon,
    component: lazyWithReload(() => import("@/components/Settings/ConfigurationSection")),
  },
];

export const DEFAULT_SETTING_SECTION: SettingSectionKey = "my-account";

export const isSettingSectionKey = (value: string): value is SettingSectionKey => {
  return SETTINGS_SECTIONS.some((section) => section.key === value);
};
