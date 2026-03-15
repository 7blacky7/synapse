"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fadeInUp, staggerContainer, modalOverlay, modalContent, durations, easings } from "@/lib/motion.config";
import { Webhook, Copy, Trash2, Check, ChevronDown, RotateCw, Eye, EyeOff } from "lucide-react";

interface WebhookType {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  lastDelivery: { success: boolean; statusCode: number; timestamp: string } | null;
  createdAt: string;
}

// Mock data
const mockWebhooks: WebhookType[] = [
  {
    id: "1",
    url: "https://api.example.com/webhooks/velocity",
    events: ["project.created", "deployment.completed"],
    active: true,
    lastDelivery: { success: true, statusCode: 200, timestamp: "2 hours ago" },
    createdAt: "Jan 15, 2026",
  },
  {
    id: "2",
    url: "https://slack.example.com/hooks/T1234",
    events: ["team.member_added", "deployment.completed"],
    active: true,
    lastDelivery: { success: true, statusCode: 200, timestamp: "1 day ago" },
    createdAt: "Feb 3, 2026",
  },
  {
    id: "3",
    url: "https://old-system.internal/callback",
    events: ["project.updated"],
    active: false,
    lastDelivery: { success: false, statusCode: 500, timestamp: "2 weeks ago" },
    createdAt: "Mar 1, 2026",
  },
];

const AVAILABLE_EVENTS = [
  { id: "project.created", label: "Project Created" },
  { id: "project.updated", label: "Project Updated" },
  { id: "deployment.started", label: "Deployment Started" },
  { id: "deployment.completed", label: "Deployment Completed" },
  { id: "team.member_added", label: "Team Member Added" },
  { id: "api_key.created", label: "API Key Created" },
];

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState(mockWebhooks);
  const [showAddModal, setShowAddModal] = useState(false);
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [expandedDeliveries, setExpandedDeliveries] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const handleAddWebhook = () => {
    if (!webhookUrl.trim() || selectedEvents.length === 0) return;

    const raw = Math.random().toString(36).substring(2, 32);
    const secret = `whk-vel-${raw}`;
    setGeneratedSecret(secret);

    const newWebhook: WebhookType = {
      id: String(Date.now()),
      url: webhookUrl,
      events: selectedEvents,
      active: true,
      lastDelivery: null,
      createdAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    };

    setWebhooks([newWebhook, ...webhooks]);
  };

  const handleCopySecret = () => {
    if (generatedSecret) {
      navigator.clipboard.writeText(generatedSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleToggleActive = (id: string) => {
    setWebhooks(webhooks.map((w) => (w.id === id ? { ...w, active: !w.active } : w)));
  };

  const handleDeleteWebhook = (id: string) => {
    setWebhooks(webhooks.filter((w) => w.id !== id));
  };

  const handleCloseModal = () => {
    setShowAddModal(false);
    setWebhookUrl("");
    setSelectedEvents([]);
    setGeneratedSecret(null);
    setCopied(false);
    setShowSecret(false);
  };

  const toggleEventSelection = (eventId: string) => {
    setSelectedEvents((prev) =>
      prev.includes(eventId) ? prev.filter((e) => e !== eventId) : [...prev, eventId]
    );
  };

  const getStatusColor = (statusCode: number | null) => {
    if (statusCode === null) return "bg-gray-500/20 text-gray-400";
    if (statusCode >= 200 && statusCode < 300) return "bg-emerald-500/20 text-emerald-400";
    if (statusCode >= 400 && statusCode < 500) return "bg-amber-500/20 text-amber-400";
    return "bg-red-500/20 text-red-400";
  };

  const containerVariants = {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: 0.05,
        delayChildren: 0.1,
      },
    },
  };

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="min-h-screen bg-gradient-to-br from-surface via-surface-raised to-surface-overlay"
    >
      {/* Header */}
      <motion.div variants={fadeInUp} className="mb-12">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-[1.75rem] font-bold text-white" style={{ fontFamily: "Syne" }}>
            Webhooks
          </h1>
          <motion.button
            onClick={() => setShowAddModal(true)}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            className="px-6 py-2.5 bg-accent text-white rounded-lg font-medium text-sm transition-all hover:brightness-110"
          >
            + Add Webhook
          </motion.button>
        </div>
        <p className="text-secondary text-sm">Receive real-time events from Velocity to your external systems</p>
      </motion.div>

      {/* Webhooks Grid */}
      <motion.div variants={staggerContainer} className="grid gap-4">
        <AnimatePresence>
          {webhooks.map((webhook, idx) => (
            <motion.div
              key={webhook.id}
              variants={fadeInUp}
              initial="hidden"
              animate="visible"
              exit="hidden"
              layout
              className="group bg-surface-raised border border-white/6 rounded-lg p-6 hover:border-accent/40 hover:bg-surface-overlay/80 transition-all duration-300"
            >
              {/* Webhook Header */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm text-muted truncate mb-2">{webhook.url}</p>
                  <div className="flex items-center gap-2">
                    {webhook.events.map((evt) => (
                      <span
                        key={evt}
                        className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs bg-accent/15 text-accent border border-accent/30"
                      >
                        {evt}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  {/* Toggle Switch */}
                  <button
                    onClick={() => handleToggleActive(webhook.id)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      webhook.active ? "bg-accent/30" : "bg-white/10"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        webhook.active ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Status Row */}
              {webhook.lastDelivery && (
                <div className="flex items-center gap-3 mb-4 pb-4 border-b border-white/6">
                  <div className="flex items-center gap-2 text-xs">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        webhook.lastDelivery.success ? "bg-emerald-400" : "bg-red-400"
                      }`}
                    />
                    <span className="text-secondary">Last delivery:</span>
                    <span
                      className={`px-2 py-1 rounded text-white text-xs font-medium ${getStatusColor(
                        webhook.lastDelivery.statusCode
                      )}`}
                    >
                      {webhook.lastDelivery.statusCode}
                    </span>
                    <span className="text-muted">{webhook.lastDelivery.timestamp}</span>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() =>
                    setExpandedDeliveries(expandedDeliveries === webhook.id ? null : webhook.id)
                  }
                  className="flex-1 px-3 py-2 text-xs font-medium text-secondary hover:text-primary bg-white/5 rounded transition-colors flex items-center justify-center gap-2"
                >
                  <RotateCw className="w-4 h-4" />
                  Deliveries
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => alert("Test webhook not yet implemented")}
                  className="flex-1 px-3 py-2 text-xs font-medium text-secondary hover:text-primary bg-white/5 rounded transition-colors flex items-center justify-center gap-2"
                >
                  <RotateCw className="w-4 h-4" />
                  Test
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => handleDeleteWebhook(webhook.id)}
                  className="px-3 py-2 text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/10 rounded transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </motion.button>
              </div>

              {/* Delivery Log Accordion */}
              <AnimatePresence>
                {expandedDeliveries === webhook.id && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: durations.normal, ease: easings.easeOut }}
                    className="mt-4 pt-4 border-t border-white/6"
                  >
                    <p className="text-xs font-semibold text-secondary mb-3">Delivery History</p>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {[
                        { event: "project.created", status: 200, duration: 145, time: "2 hours ago" },
                        { event: "deployment.completed", status: 200, duration: 234, time: "1 day ago" },
                        { event: "test", status: 200, duration: 156, time: "3 days ago" },
                      ].map((delivery, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-xs bg-white/5 p-2 rounded border border-white/10"
                        >
                          <div className="flex-1">
                            <p className="text-primary font-medium">{delivery.event}</p>
                            <p className="text-muted">{delivery.time}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className={`px-2 py-1 rounded font-mono ${getStatusColor(delivery.status)}`}>
                              {delivery.status}
                            </span>
                            <span className="text-muted">{delivery.duration}ms</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>

      {/* Add Webhook Modal */}
      <AnimatePresence>
        {showAddModal && (
          <>
            <motion.div
              variants={modalOverlay}
              initial="hidden"
              animate="visible"
              exit="hidden"
              onClick={handleCloseModal}
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            />
            <motion.div
              variants={modalContent}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="fixed inset-0 flex items-center justify-center pointer-events-none"
            >
              <div className="w-full max-w-md bg-surface-overlay border border-white/10 rounded-lg p-8 pointer-events-auto shadow-2xl backdrop-blur-xl bg-opacity-90">
                <h2 className="text-xl font-bold text-white mb-6" style={{ fontFamily: "Syne" }}>
                  Add Webhook
                </h2>

                {!generatedSecret ? (
                  <>
                    {/* URL Input */}
                    <div className="mb-6">
                      <label className="block text-sm font-medium text-secondary mb-2">Webhook URL</label>
                      <input
                        type="url"
                        placeholder="https://example.com/webhook"
                        value={webhookUrl}
                        onChange={(e) => setWebhookUrl(e.target.value)}
                        className="w-full px-4 py-3 bg-surface border border-white/6 rounded-lg text-white placeholder-muted focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all"
                      />
                    </div>

                    {/* Events Selection */}
                    <div className="mb-6">
                      <label className="block text-sm font-medium text-secondary mb-3">Events</label>
                      <div className="space-y-2">
                        {AVAILABLE_EVENTS.map((evt) => (
                          <label
                            key={evt.id}
                            className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10 hover:border-accent/30 cursor-pointer transition-all"
                          >
                            <input
                              type="checkbox"
                              checked={selectedEvents.includes(evt.id)}
                              onChange={() => toggleEventSelection(evt.id)}
                              className="w-4 h-4 accent-accent rounded cursor-pointer"
                            />
                            <span className="text-sm text-primary">{evt.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-3">
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={handleCloseModal}
                        className="flex-1 px-4 py-2.5 bg-white/10 text-white rounded-lg font-medium text-sm hover:bg-white/20 transition-colors"
                      >
                        Cancel
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={handleAddWebhook}
                        disabled={!webhookUrl.trim() || selectedEvents.length === 0}
                        className="flex-1 px-4 py-2.5 bg-accent text-white rounded-lg font-medium text-sm hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        Create Webhook
                      </motion.button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Secret Display */}
                    <div className="mb-6 p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                      <p className="text-xs font-semibold text-emerald-400 mb-3">Secret Generated</p>
                      <p className="text-xs text-secondary mb-3">
                        Copy this secret now. We won't show it again for security reasons.
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type={showSecret ? "text" : "password"}
                          value={generatedSecret}
                          readOnly
                          className="flex-1 px-3 py-2 bg-surface border border-white/10 rounded text-xs font-mono text-white"
                        />
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => setShowSecret(!showSecret)}
                          className="p-2 text-muted hover:text-primary transition-colors"
                        >
                          {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </motion.button>
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={handleCopySecret}
                          className="p-2 text-muted hover:text-primary transition-colors"
                        >
                          {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                        </motion.button>
                      </div>
                    </div>

                    {/* Close Button */}
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={handleCloseModal}
                      className="w-full px-4 py-2.5 bg-accent text-white rounded-lg font-medium text-sm hover:brightness-110 transition-all"
                    >
                      Done
                    </motion.button>
                  </>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
