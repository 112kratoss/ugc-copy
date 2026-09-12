import AppShellClient from './AppShellClient';

export default function AppShell({ children }: { children: React.ReactNode }) {
  return <AppShellClient>{children}</AppShellClient>;
}
