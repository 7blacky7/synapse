"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  Settings,
  Shield,
  LogOut,
  User,
  ChevronDown,
  X,
  BarChart3,
  Key,
  CreditCard,
  Clock,
  MessageSquare,
  Webhook,
} from "lucide-react";
import NotificationCenter from "./NotificationCenter";

interface SidebarProps {
  currentPath: string;
}

const mainLinks = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/dashboard/analytics", icon: BarChart3, label: "Analytics" },
  { href: "/dashboard/activity", icon: Clock, label: "Activity" },
  { href: "/dashboard/projects", icon: FolderKanban, label: "Projects" },
  { href: "/dashboard/team", icon: Users, label: "Team" },
  { href: "/dashboard/community", icon: MessageSquare, label: "Community" },
];

const systemLinks = [
  { href: "/dashboard/api-keys", icon: Key, label: "API Keys" },
  { href: "/dashboard/webhooks", icon: Webhook, label: "Webhooks" },
  { href: "/dashboard/billing", icon: CreditCard, label: "Billing" },
  { href: "/dashboard/settings", icon: Settings, label: "Settings" },
  { href: "/admin/users", icon: Shield, label: "Admin", badge: "Admin" },
];

export default function Sidebar({ currentPath }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);

  const isLinkActive = (href: string) => {
    return currentPath === href || currentPath.startsWith(href);
  };

  const userInfo = {
    name: "Alex Johnson",
    email: "alex@example.com",
    initials: "AJ",
    role: "Admin",
  };

  return (
    <>
      {/* Mobile Backdrop */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar Container */}
      <motion.aside
        initial={{ x: "-100%" }}
        animate={{ x: mobileOpen ? 0 : "-100%" }}
        exit={{ x: "-100%" }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="fixed lg:sticky left-0 top-0 bottom-0 w-[260px] bg-[#111111] border-r border-[rgba(255,255,255,0.06)] flex flex-col z-50 lg:translate-x-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[rgba(255,255,255,0.06)]">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#f97316] flex items-center justify-center">
              <span className="text-sm font-bold text-black">V</span>
            </div>
            <span className="font-bold text-[#fafafa] font-display text-sm">Velocity</span>
          </div>

          <div className="flex items-center gap-2">
            {/* Notification Center */}
            <NotificationCenter />

            {/* Close button for mobile */}
            <button
              onClick={() => setMobileOpen(false)}
              className="lg:hidden p-1 hover:bg-[rgba(255,255,255,0.04)] rounded transition-colors"
            >
              <X size={18} className="text-[rgba(255,255,255,0.5)]" />
            </button>
          </div>
        </div>

        {/* Navigation Sections */}
        <nav className="flex-1 overflow-y-auto py-6 px-3 space-y-8">
          {/* Main Section */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.4)] px-4 mb-3">
              Main
            </p>
            <div className="space-y-1">
              {mainLinks.map((link) => {
                const Icon = link.icon;
                const active = isLinkActive(link.href);

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                      active
                        ? "bg-[rgba(249,115,22,0.1)] text-[#f97316] border-l-[3px] border-[#f97316]"
                        : "text-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[rgba(255,255,255,0.7)]"
                    }`}
                  >
                    <Icon
                      size={18}
                      className={active ? "text-[#f97316]" : ""}
                      fill={active ? "currentColor" : "none"}
                    />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* System Section */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.4)] px-4 mb-3">
              System
            </p>
            <div className="space-y-1">
              {systemLinks.map((link) => {
                const Icon = link.icon;
                const active = isLinkActive(link.href);

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 relative ${
                      active
                        ? "bg-[rgba(249,115,22,0.1)] text-[#f97316] border-l-[3px] border-[#f97316]"
                        : "text-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[rgba(255,255,255,0.7)]"
                    }`}
                  >
                    <Icon
                      size={18}
                      className={active ? "text-[#f97316]" : ""}
                      fill={active ? "currentColor" : "none"}
                    />
                    <span>{link.label}</span>
                    {link.badge && (
                      <span className="ml-auto text-xs font-semibold px-2 py-0.5 bg-[rgba(249,115,22,0.15)] text-[#f97316] rounded">
                        {link.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        {/* User Area */}
        <div className="mt-auto border-t border-[rgba(255,255,255,0.06)] p-4">
          <div className="relative">
            {/* User Button */}
            <button
              onClick={() => setUserDropdownOpen(!userDropdownOpen)}
              className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-[rgba(255,255,255,0.04)] transition-all duration-150 group"
            >
              {/* Avatar */}
              <div className="flex-shrink-0 w-9 h-9 rounded-full bg-[#f97316] flex items-center justify-center border-2 border-[#f97316]">
                <span className="text-xs font-bold text-black">{userInfo.initials}</span>
              </div>

              {/* User Info */}
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-medium text-[#fafafa] truncate">
                  {userInfo.name}
                </p>
                <p className="text-xs text-[rgba(255,255,255,0.4)] truncate">
                  {userInfo.role}
                </p>
              </div>

              {/* Dropdown Arrow */}
              <ChevronDown
                size={16}
                className={`flex-shrink-0 text-[rgba(255,255,255,0.5)] transition-transform duration-200 ${
                  userDropdownOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {/* User Dropdown Menu */}
            <AnimatePresence>
              {userDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  className="absolute bottom-full left-0 right-0 mb-2 bg-[#1a1a1a] border border-[rgba(255,255,255,0.08)] rounded-lg shadow-lg overflow-hidden"
                >
                  {/* User Info Header */}
                  <div className="p-3 border-b border-[rgba(255,255,255,0.06)]">
                    <p className="text-sm font-medium text-[#fafafa]">
                      {userInfo.name}
                    </p>
                    <p className="text-xs text-[rgba(255,255,255,0.4)]">
                      {userInfo.email}
                    </p>
                  </div>

                  {/* Menu Items */}
                  <button className="w-full text-left px-4 py-2 text-sm text-[rgba(255,255,255,0.6)] hover:text-[rgba(255,255,255,0.9)] hover:bg-[rgba(255,255,255,0.04)] transition-colors flex items-center gap-2">
                    <User size={14} />
                    <span>Profile</span>
                  </button>

                  <button className="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-[rgba(255,255,255,0.04)] transition-colors flex items-center gap-2 border-t border-[rgba(255,255,255,0.06)]">
                    <LogOut size={14} />
                    <span>Logout</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.aside>

      {/* Mobile Hamburger Button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed bottom-6 left-6 lg:hidden p-3 bg-[#f97316] rounded-lg hover:bg-[#fb923c] transition-all duration-150 z-30 hover:scale-105 active:scale-95 shadow-lg"
      >
        <svg
          className="w-6 h-6 text-black"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      </button>
    </>
  );
}
