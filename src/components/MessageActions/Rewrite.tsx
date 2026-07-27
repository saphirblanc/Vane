'use client';

import { Cpu, Loader2, Repeat, Search, Sliders, Star, Zap } from 'lucide-react';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { MinimalProvider } from '@/lib/models/types';
import { RewriteOverrides, useChat } from '@/lib/hooks/useChat';
import { cn } from '@/lib/utils';

/**
 * Retry, but with a choice of model and mode for that one answer.
 *
 * The stock button re-runs with whatever the chat is already set to, which
 * makes "the fast model got this wrong, try the good one" a three-step detour
 * through the composer - and leaves the chat on the heavier model afterwards.
 * Both selections here are scoped to the single retry.
 */

const MODES = [
  {
    key: 'speed',
    title: 'Speed',
    icon: <Zap size={14} className="text-[#FF9800]" />,
  },
  {
    key: 'balanced',
    title: 'Balanced',
    icon: <Sliders size={14} className="text-[#4CAF50]" />,
  },
  {
    key: 'quality',
    title: 'Quality',
    icon: (
      <Star
        size={14}
        className="text-[#2196F3] dark:text-[#BBDEFB] fill-[#BBDEFB] dark:fill-[#2196F3]"
      />
    ),
  },
];

const Rewrite = ({
  rewrite,
  messageId,
}: {
  rewrite: (messageId: string, overrides?: RewriteOverrides) => void;
  messageId: string;
}) => {
  const { chatModelProvider, optimizationMode } = useChat();

  const [providers, setProviders] = useState<MinimalProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState(optimizationMode);

  /* The panel is mounted per message, so the picked mode resets to the chat's
   * own mode every time it is reopened. */
  useEffect(() => setMode(optimizationMode), [optimizationMode]);

  useEffect(() => {
    const loadProviders = async () => {
      try {
        const res = await fetch('/api/providers');

        if (!res.ok) throw new Error('Failed to fetch providers');

        const data: { providers: MinimalProvider[] } = await res.json();
        setProviders(data.providers);
      } catch (error) {
        console.error('Error loading providers:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadProviders();
  }, []);

  const orderedProviders = useMemo(() => {
    const index = providers.findIndex(
      (p) => p.id === chatModelProvider?.providerId,
    );

    if (index === -1) return providers;

    return [
      providers[index],
      ...providers.filter((_, i) => i !== index),
    ];
  }, [providers, chatModelProvider]);

  const filteredProviders = orderedProviders
    .map((provider) => ({
      ...provider,
      chatModels: provider.chatModels.filter(
        (model) =>
          model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          provider.name.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    }))
    .filter((provider) => provider.chatModels.length > 0);

  return (
    <Popover className="relative">
      {({ open, close }) => (
        <>
          <PopoverButton
            type="button"
            title="Retry with a different model or mode"
            className="p-2 text-black/70 dark:text-white/70 rounded-full hover:bg-light-secondary dark:hover:bg-dark-secondary transition duration-200 hover:text-black dark:hover:text-white flex flex-row items-center space-x-1"
          >
            <Repeat size={16} />
          </PopoverButton>

          <AnimatePresence>
            {open && (
              <PopoverPanel
                className="absolute z-10 w-[250px] sm:w-[290px] left-0 bottom-full mb-2"
                static
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.1, ease: 'easeOut' }}
                  className="origin-bottom-left bg-light-primary dark:bg-dark-primary border rounded-lg border-light-200 dark:border-dark-200 w-full flex flex-col shadow-lg overflow-hidden"
                >
                  <div className="p-2 border-b border-light-200 dark:border-dark-200 space-y-2">
                    <div className="flex flex-row items-center gap-1">
                      {MODES.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => setMode(m.key)}
                          className={cn(
                            'flex-1 flex flex-row items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs transition duration-200',
                            mode === m.key
                              ? 'bg-light-secondary dark:bg-dark-secondary text-black dark:text-white'
                              : 'text-black/60 dark:text-white/60 hover:bg-light-secondary dark:hover:bg-dark-secondary',
                          )}
                        >
                          {m.icon}
                          <span className="truncate">{m.title}</span>
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        close();
                        rewrite(messageId, { optimizationMode: mode });
                      }}
                      className="w-full flex flex-row items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-black/70 dark:text-white/70 hover:bg-light-secondary dark:hover:bg-dark-secondary hover:text-black dark:hover:text-white transition duration-200"
                    >
                      <Repeat size={14} />
                      <span>Retry with the same model</span>
                    </button>
                  </div>

                  <div className="p-2 border-b border-light-200 dark:border-dark-200">
                    <div className="relative">
                      <Search
                        size={16}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-black/40 dark:text-white/40"
                      />
                      <input
                        type="text"
                        placeholder="Search models..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-3 py-2 bg-light-secondary dark:bg-dark-secondary rounded-lg placeholder:text-xs placeholder:-translate-y-[1.5px] text-xs text-black dark:text-white placeholder:text-black/40 dark:placeholder:text-white/40 focus:outline-none border border-transparent transition duration-200"
                      />
                    </div>
                  </div>

                  <div className="max-h-[260px] overflow-y-auto">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-10">
                        <Loader2
                          className="animate-spin text-black/40 dark:text-white/40"
                          size={20}
                        />
                      </div>
                    ) : filteredProviders.length === 0 ? (
                      <div className="text-center py-10 px-4 text-black/60 dark:text-white/60 text-sm">
                        {searchQuery
                          ? 'No models found'
                          : 'No chat models configured'}
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        {filteredProviders.map((provider, providerIndex) => (
                          <div key={provider.id}>
                            <div className="px-4 py-2.5 sticky top-0 bg-light-primary dark:bg-dark-primary border-b border-light-200/50 dark:border-dark-200/50">
                              <p className="text-xs text-black/50 dark:text-white/50 uppercase tracking-wider">
                                {provider.name}
                              </p>
                            </div>

                            <div className="flex flex-col px-2 py-2 space-y-0.5">
                              {provider.chatModels.map((model) => {
                                const isCurrent =
                                  chatModelProvider?.providerId ===
                                    provider.id &&
                                  chatModelProvider?.key === model.key;

                                return (
                                  <button
                                    key={model.key}
                                    type="button"
                                    onClick={() => {
                                      close();
                                      rewrite(messageId, {
                                        chatModel: {
                                          providerId: provider.id,
                                          key: model.key,
                                        },
                                        optimizationMode: mode,
                                      });
                                    }}
                                    className="px-3 py-2 flex items-center justify-between text-start duration-200 cursor-pointer transition rounded-lg group hover:bg-light-secondary dark:hover:bg-dark-secondary"
                                  >
                                    <div className="flex items-center space-x-2.5 min-w-0 flex-1">
                                      <Cpu
                                        size={15}
                                        className={cn(
                                          'shrink-0',
                                          isCurrent
                                            ? 'text-sky-500'
                                            : 'text-black/50 dark:text-white/50 group-hover:text-black/70 group-hover:dark:text-white/70',
                                        )}
                                      />
                                      <p
                                        className={cn(
                                          'text-xs truncate',
                                          isCurrent
                                            ? 'text-sky-500 font-medium'
                                            : 'text-black/70 dark:text-white/70 group-hover:text-black dark:group-hover:text-white',
                                        )}
                                      >
                                        {model.name}
                                      </p>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>

                            {providerIndex < filteredProviders.length - 1 && (
                              <div className="h-px bg-light-200 dark:bg-dark-200" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              </PopoverPanel>
            )}
          </AnimatePresence>
        </>
      )}
    </Popover>
  );
};

export default Rewrite;
