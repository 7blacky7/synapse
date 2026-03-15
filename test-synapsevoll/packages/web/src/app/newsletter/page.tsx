'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import Link from 'next/link';
import { Home, Mail, CheckCircle, Twitter, Linkedin, MessageSquare } from 'lucide-react';
import { fadeInUp, staggerContainer, scaleIn, easings, durations } from '@/lib/motion.config';

interface NewsletterFormState {
  email: string;
  frequency: 'weekly' | 'monthly';
  topics: {
    productUpdates: boolean;
    engineeringBlog: boolean;
    communityHighlights: boolean;
    securityAdvisories: boolean;
  };
  submitted: boolean;
}

const INITIAL_FORM_STATE: NewsletterFormState = {
  email: '',
  frequency: 'weekly',
  topics: {
    productUpdates: true,
    engineeringBlog: false,
    communityHighlights: true,
    securityAdvisories: true,
  },
  submitted: false,
};

const TOPIC_OPTIONS = [
  { key: 'productUpdates' as const, label: 'Product Updates' },
  { key: 'engineeringBlog' as const, label: 'Engineering Blog' },
  { key: 'communityHighlights' as const, label: 'Community Highlights' },
  { key: 'securityAdvisories' as const, label: 'Security Advisories' },
];

const SOCIAL_LINKS = [
  { platform: 'Twitter', icon: Twitter, href: 'https://twitter.com', label: 'Follow us on Twitter' },
  { platform: 'LinkedIn', icon: Linkedin, href: 'https://linkedin.com', label: 'Connect on LinkedIn' },
  { platform: 'Discord', icon: MessageSquare, href: 'https://discord.com', label: 'Join our Discord' },
];

export default function NewsletterPage() {
  const [formState, setFormState] = useState<NewsletterFormState>(INITIAL_FORM_STATE);
  const [isLoading, setIsLoading] = useState(false);

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormState((prev) => ({
      ...prev,
      email: e.target.value,
    }));
  };

  const handleFrequencyChange = (frequency: 'weekly' | 'monthly') => {
    setFormState((prev) => ({
      ...prev,
      frequency,
    }));
  };

  const handleTopicChange = (topic: keyof NewsletterFormState['topics']) => {
    setFormState((prev) => ({
      ...prev,
      topics: {
        ...prev.topics,
        [topic]: !prev.topics[topic],
      },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1200));

    setFormState((prev) => ({
      ...prev,
      submitted: true,
    }));

    setIsLoading(false);

    // Reset success state after 5 seconds
    setTimeout(() => {
      setFormState(INITIAL_FORM_STATE);
    }, 5000);
  };

  return (
    <div className="min-h-screen bg-[var(--color-surface)] relative overflow-hidden">
      {/* Grid Background Pattern - 15% opacity */}
      <div
        className="fixed inset-0 grid-pattern pointer-events-none"
        style={{
          opacity: 0.15,
        }}
      />

      <div className="relative z-10">
        {/* ===== NAVBAR ===== */}
        <nav className="border-b border-[rgba(255,255,255,0.06)] bg-[rgba(10,10,10,0.8)] backdrop-blur-sm sticky top-0 z-40">
          <div className="max-w-[768px] mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-6">
              <Link
                href="/"
                className="p-2 hover:bg-[rgba(255,255,255,0.05)] rounded-lg transition-colors duration-200"
                aria-label="Go to home page"
              >
                <Home size={16} className="text-[rgba(255,255,255,0.5)]" />
              </Link>
              <div className="flex items-center gap-4 text-sm">
                <Link
                  href="/"
                  className="text-[rgba(255,255,255,0.6)] hover:text-[rgba(255,255,255,0.9)] transition-colors duration-200"
                >
                  Home
                </Link>
                <span className="text-[rgba(255,255,255,0.3)]">|</span>
                <Link
                  href="/contact"
                  className="text-[rgba(255,255,255,0.6)] hover:text-[rgba(255,255,255,0.9)] transition-colors duration-200"
                >
                  Contact
                </Link>
              </div>
            </div>

            <Link
              href="/"
              className="text-[0.875rem] font-semibold font-display text-[#f97316] hover:text-[#fb923c] transition-colors duration-200"
            >
              Velocity
            </Link>
          </div>
        </nav>

        {/* ===== MAIN CONTENT ===== */}
        <div className="max-w-[768px] mx-auto px-6 py-16">
          {/* ===== HERO SECTION ===== */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: durations.normal, ease: easings.easeOut }}
            className="mb-16 text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.4, ease: easings.easeOut }}
              className="flex justify-center mb-6"
            >
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#f97316] to-[#fb923c] flex items-center justify-center">
                <Mail size={32} className="text-black" />
              </div>
            </motion.div>

            <h1 className="text-[1.75rem] font-bold text-[rgba(255,255,255,0.9)] font-display leading-tight mb-4">
              Stay in the Loop
            </h1>
            <p className="text-[0.875rem] text-[rgba(255,255,255,0.5)] font-body max-w-md mx-auto">
              Get the latest updates, tutorials, and product news delivered to your inbox.
            </p>
          </motion.div>

          {/* ===== FORM CONTAINER ===== */}
          <motion.div
            variants={scaleIn}
            initial="hidden"
            animate="visible"
            className="rounded-xl p-8 bg-[rgba(255,255,255,0.03)] backdrop-blur-[16px] border border-[rgba(255,255,255,0.06)] hover:border-[rgba(255,255,255,0.12)] transition-all duration-200"
          >
            <AnimatePresence mode="wait">
              {!formState.submitted ? (
                <motion.form
                  key="form"
                  onSubmit={handleSubmit}
                  className="space-y-6"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: durations.normal, ease: easings.easeOut }}
                >
                  {/* Email Input */}
                  <div className="space-y-2">
                    <label className="text-[0.875rem] font-medium text-[rgba(255,255,255,0.7)] font-body block">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={formState.email}
                      onChange={handleEmailChange}
                      required
                      placeholder="your@email.com"
                      className="w-full px-4 py-3 rounded-lg bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] text-[rgba(255,255,255,0.9)] placeholder-[rgba(255,255,255,0.3)] text-sm focus:outline-none focus:border-[#f97316] focus:ring-1 focus:ring-[rgba(249,115,22,0.2)] transition-all duration-200"
                      aria-label="Email address"
                    />
                  </div>

                  {/* Frequency Selection */}
                  <div className="space-y-3">
                    <label className="text-[0.875rem] font-medium text-[rgba(255,255,255,0.7)] font-body block">
                      Update Frequency
                    </label>
                    <div className="flex gap-3">
                      {(['weekly', 'monthly'] as const).map((freq) => (
                        <button
                          key={freq}
                          type="button"
                          onClick={() => handleFrequencyChange(freq)}
                          aria-label={`Select ${freq} updates`}
                          aria-pressed={formState.frequency === freq}
                          className={`flex-1 px-4 py-2.5 rounded-lg text-[0.875rem] font-medium font-body transition-all duration-200 ${
                            formState.frequency === freq
                              ? 'bg-[#f97316] text-black border border-[#f97316]'
                              : 'bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] text-[rgba(255,255,255,0.7)] hover:bg-[rgba(255,255,255,0.08)]'
                          }`}
                        >
                          {freq.charAt(0).toUpperCase() + freq.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Topics Checkboxes */}
                  <div className="space-y-3">
                    <label className="text-[0.875rem] font-medium text-[rgba(255,255,255,0.7)] font-body block">
                      Topics of Interest
                    </label>
                    <div className="space-y-2.5">
                      {TOPIC_OPTIONS.map(({ key, label }) => (
                        <label
                          key={key}
                          className="flex items-center gap-3 cursor-pointer group"
                        >
                          <input
                            type="checkbox"
                            checked={formState.topics[key]}
                            onChange={() => handleTopicChange(key)}
                            className="w-4 h-4 rounded border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.05)] cursor-pointer accent-[#f97316] focus:outline-none focus:ring-1 focus:ring-[#f97316]"
                            aria-label={label}
                          />
                          <span className="text-[0.875rem] text-[rgba(255,255,255,0.7)] font-body group-hover:text-[rgba(255,255,255,0.9)] transition-colors duration-200">
                            {label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Subscribe Button */}
                  <button
                    type="submit"
                    disabled={isLoading || !formState.email}
                    aria-label={isLoading ? 'Subscribing' : 'Subscribe to newsletter'}
                    className="w-full px-6 py-3 rounded-lg bg-[#f97316] text-black font-semibold text-[0.875rem] hover:bg-[#fb923c] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 font-body"
                  >
                    {isLoading ? 'Subscribing...' : 'Subscribe'}
                  </button>

                  {/* Privacy Note */}
                  <p className="text-[0.75rem] text-[rgba(255,255,255,0.4)] font-body text-center">
                    We respect your privacy.{' '}
                    <button
                      type="button"
                      className="text-[#f97316] hover:text-[#fb923c] transition-colors duration-200 underline"
                      aria-label="Unsubscribe anytime"
                    >
                      Unsubscribe anytime.
                    </button>
                  </p>
                </motion.form>
              ) : (
                /* Success State */
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: durations.normal, ease: easings.easeOut }}
                  className="flex flex-col items-center justify-center py-12 text-center"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.3, ease: easings.easeOut }}
                    className="mb-4"
                  >
                    <CheckCircle size={56} className="text-[#34d399]" />
                  </motion.div>
                  <h2 className="text-[1.125rem] font-semibold text-[rgba(255,255,255,0.9)] mb-2 font-display">
                    You're subscribed!
                  </h2>
                  <p className="text-[0.875rem] text-[rgba(255,255,255,0.5)] font-body">
                    Check your email for a confirmation link.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* ===== SOCIAL LINKS ===== */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="mt-16 text-center"
          >
            <p className="text-[0.875rem] text-[rgba(255,255,255,0.6)] font-body mb-6">
              Also find us here:
            </p>
            <motion.div
              className="flex items-center justify-center gap-4"
              variants={scaleIn}
            >
              {SOCIAL_LINKS.map(({ platform, icon: Icon, href, label }) => (
                <motion.a
                  key={platform}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="w-12 h-12 rounded-full bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] flex items-center justify-center text-[rgba(255,255,255,0.6)] hover:text-[#f97316] hover:border-[rgba(249,115,22,0.4)] hover:bg-[rgba(249,115,22,0.05)] transition-all duration-200"
                >
                  <Icon size={20} />
                </motion.a>
              ))}
            </motion.div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
