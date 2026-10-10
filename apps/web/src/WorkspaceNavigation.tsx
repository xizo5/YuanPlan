import { AppShell, Avatar, Button, Divider, Group, Menu, NavLink, Stack, Text } from '@mantine/core';
import { IconChecklist, IconDots, IconFolders, IconLogout, IconPlug, IconSettings, IconUsers } from '@tabler/icons-react';
import type { User } from '@yuanplan/contracts';
import { navigate } from './api';
import { NotificationBell } from './Notifications';

type Props = { user: User; section: string; onLogout: () => void };

export function WorkspaceNavigation({ user, section, onLogout }: Props) {
  const projectsActive = section === '' || section === 'projects';
  const links = [
    { path: '/', label: '我的项目', icon: IconFolders, active: projectsActive },
    { path: '/my-tasks', label: '我的任务', icon: IconChecklist, active: section === 'my-tasks' },
    { path: '/teams', label: '团队', icon: IconUsers, active: section === 'teams' },
    { path: '/integrations', label: 'AI 与集成', icon: IconPlug, active: section === 'integrations' },
  ];
  return <AppShell.Navbar component="nav" aria-label="工作空间导航" p="sm" className="sidebar">
    <div className="sidebar-brand"><Group gap="sm"><img className="brand-mark" src="/yuanplan-logo.png?v=a2-rounded-20260929" alt=""/><Text fw={750} size="lg">YuanPlan</Text></Group><div className="notification-trigger-mobile"><NotificationBell/></div></div>
    <Text className="nav-caption">工作空间</Text>
    {links.map(link => <NavLink className="desktop-nav-link" component="button" type="button" key={link.path} label={link.label} leftSection={<link.icon size={19}/>} active={link.active} onClick={() => navigate(link.path)} mb={2} bdrs="sm"/>)}
    <div className="mobile-navigation">
      <NavLink component="button" type="button" label="我的任务" leftSection={<IconChecklist size={19}/>} active={section === 'my-tasks'} onClick={() => navigate('/my-tasks')} aria-current={section === 'my-tasks' ? 'page' : undefined}/>
      <NavLink component="button" type="button" label="我的项目" leftSection={<IconFolders size={19}/>} active={projectsActive} onClick={() => navigate('/')} aria-current={projectsActive ? 'page' : undefined}/>
      <Menu position="bottom-end" withinPortal><Menu.Target><Button className="mobile-more-trigger" variant="subtle" color="gray" leftSection={<IconDots size={19}/>} aria-label="更多页面和账号操作">更多</Button></Menu.Target><Menu.Dropdown className="mobile-more-menu">
        <Menu.Item leftSection={<IconUsers size={18}/>} onClick={() => navigate('/teams')}>团队</Menu.Item>
        <Menu.Item leftSection={<IconPlug size={18}/>} onClick={() => navigate('/integrations')}>AI 与集成</Menu.Item>
        {user.isAdmin && <Menu.Item leftSection={<IconSettings size={18}/>} onClick={() => navigate('/settings')}>系统管理</Menu.Item>}
        <Menu.Divider/><Menu.Label>{user.name} · {user.email}</Menu.Label>
        <Menu.Item leftSection={<IconLogout size={18}/>} onClick={onLogout}>退出登录</Menu.Item>
      </Menu.Dropdown></Menu>
    </div>
    <div className="sidebar-bottom">{user.isAdmin && <NavLink component="button" type="button" label="系统管理" leftSection={<IconSettings size={18}/>} onClick={() => navigate('/settings')} active={section === 'settings'}/>}<Divider my="md"/><Group wrap="nowrap"><Avatar color="forest" radius="xl">{user.name.slice(0,1)}</Avatar><Stack gap={0} style={{ flex: 1, minWidth: 0 }}><Text size="sm" fw={600} truncate>{user.name}</Text><Text size="xs" c="dimmed" truncate>{user.email}</Text></Stack><Button variant="subtle" size="compact-sm" aria-label="退出登录" onClick={onLogout}><IconLogout size={17}/></Button></Group></div>
  </AppShell.Navbar>;
}
