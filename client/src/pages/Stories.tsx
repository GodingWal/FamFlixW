import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import AdBanner from "@/components/AdBanner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";
import Seo, { BASE_URL } from "@/components/Seo";
import { cn } from "@/lib/utils";

type StoryCategory =
  | "BEDTIME"
  | "CLASSIC"
  | "FAIRYTALE"
  | "ADVENTURE"
  | "EDUCATIONAL"
  | "CUSTOM"
  | string;

interface StorySummary {
  id: string;
  slug: string;
  title: string;
  author: string | null;
  category: StoryCategory;
  rights: string;
  tags: string[];
  coverUrl: string | null;
  summary: string | null;
  ageRange: {
    min: number | null;
    max: number | null;
  };
  durationMin: number | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

interface VoiceProfile {
  id: string;
  name: string;
  displayName?: string;
  status?: string;
}

interface StorySection {
  id: string;
  index: number;
  title: string | null;
  wordCount: number;
  text?: string;
}

type StoryAudioStatus = "PENDING" | "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR" | string;

interface StoryAudioEntry {
  status: StoryAudioStatus;
  audioUrl: string | null;
  durationSec: number | null;
  checksum: string | null;
  transcript: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

interface StoryDetailResponse extends StorySummary {
  content?: string;
  sections: StorySection[];
}

interface StoryAudioSection extends StorySection {
  audio: StoryAudioEntry;
}

interface StoryAudioResponse {
  story: StorySummary;
  voice: {
    id: string;
    displayName?: string;
  };
  sections: StoryAudioSection[];
}

interface StoryListResponse {
  total: number;
  stories: StorySummary[];
}

interface ReadResponse {
  ready: boolean;
  jobId: string | null;
  state?: string;
  progress?: number;
  story: {
    id: string;
    slug: string;
    title: string;
  };
  voice: {
    id: string;
    displayName?: string;
  };
  sections?: StoryAudioSection[];
}

interface StoryJobStatus {
  id: string;
  state: string;
  progress: number;
  attempts: number;
  data: {
    storyId: string;
    voiceId: string;
  };
  failedReason: string | null;
  result: unknown;
  timestamp: {
    createdAt: string | null;
    finishedAt: string | null;
  };
}

interface ActiveJob {
  jobId: string;
  slug: string;
  voiceId: string;
}

const EMPTY_AUDIO_ENTRY: StoryAudioEntry = {
  status: "PENDING",
  audioUrl: null,
  durationSec: null,
  checksum: null,
  transcript: null,
  error: null,
  metadata: {},
  startedAt: null,
  completedAt: null,
  updatedAt: null,
};

const STATUS_BADGE_CLASS: Record<StoryAudioStatus, string> = {
  PENDING: "bg-slate-800 text-slate-200 border border-slate-600",
  QUEUED: "bg-amber-500/20 text-amber-200 border border-amber-500/40",
  PROCESSING: "bg-sky-500/20 text-sky-100 border border-sky-500/50",
  COMPLETE: "bg-emerald-500/20 text-emerald-100 border border-emerald-500/50",
  ERROR: "bg-rose-500/20 text-rose-100 border border-rose-500/40",
};

const JOB_STATE_LABEL: Record<string, string> = {
  waiting: "Waiting in queue",
  delayed: "Delayed",
  active: "Generating audio",
  completed: "Completed",
  failed: "Failed",
  paused: "Paused",
  stuck: "Stuck",
  waitingChildren: "Waiting on subtasks",
};

const jobStateBadge = (state: string) => {
  switch (state) {
    case "completed":
      return "bg-emerald-500/20 text-emerald-100 border border-emerald-500/40";
    case "active":
      return "bg-sky-500/20 text-sky-100 border border-sky-500/40";
    case "failed":
      return "bg-rose-500/20 text-rose-100 border border-rose-500/40";
    case "waiting":
    case "waitingChildren":
      return "bg-amber-500/20 text-amber-100 border border-amber-500/40";
    default:
      return "bg-slate-800 text-slate-200 border border-slate-600";
  }
};

const formatMinutes = (minutes: number | null | undefined) => {
  if (!minutes || Number.isNaN(minutes)) {
    return null;
  }
  if (minutes < 1) {
    return "<1 minute";
  }
  if (minutes < 60) {
    return `${Math.round(minutes)} minute${minutes >= 1.5 ? "s" : ""}`;
  }
  const hours = minutes / 60;
  if (hours < 3) {
    return `${hours.toFixed(1)} hours`;
  }
  return `${Math.round(hours)} hours`;
};

export default function Stories() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedVoiceProfile, setSelectedVoiceProfile] = useState<string | null>(
    null
  );
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [jobStatus, setJobStatus] = useState<StoryJobStatus | null>(null);
  const [isPlayAll, setIsPlayAll] = useState(false);
  const [playIndex, setPlayIndex] = useState<number>(0);
  const playAllAudioRef = useRef<HTMLAudioElement | null>(null);

  const {
    data: storiesResponse,
    isLoading: storiesLoading,
    isError: storiesError,
  } = useQuery<StoryListResponse>({
    queryKey: ["story-catalog"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/stories");
      return response.json();
    },
  });

  const stories = storiesResponse?.stories ?? [];

  const {
    data: voiceProfiles = [],
    isLoading: voicesLoading,
  } = useQuery<VoiceProfile[]>({
    queryKey: ["voice-profiles"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/voice-profiles");
      return response.json();
    },
  });

  useEffect(() => {
    if (!selectedVoiceProfile && voiceProfiles.length > 0) {
      setSelectedVoiceProfile(voiceProfiles[0].id);
    }
  }, [voiceProfiles, selectedVoiceProfile]);

  useEffect(() => {
    if (!selectedSlug && stories.length > 0) {
      setSelectedSlug(stories[0].slug);
    }
  }, [stories, selectedSlug]);

  const selectedVoice = useMemo(
    () => voiceProfiles.find((profile) => profile.id === selectedVoiceProfile) ?? null,
    [voiceProfiles, selectedVoiceProfile]
  );

  const categories = useMemo(
    () =>
      Array.from(new Set(stories.map((story) => story.category || "UNCATEGORIZED"))).sort(
        (a, b) => a.localeCompare(b)
      ),
    [stories]
  );

  const filteredStories = useMemo(() => {
    if (categoryFilter === "ALL") {
      return stories;
    }
    return stories.filter(
      (story) =>
        (story.category || "UNCATEGORIZED").toUpperCase() === categoryFilter.toUpperCase()
    );
  }, [stories, categoryFilter]);

  const selectedStorySummary = useMemo(
    () => stories.find((story) => story.slug === selectedSlug) ?? null,
    [stories, selectedSlug]
  );

  const {
    data: storyDetail,
    isLoading: detailLoading,
  } = useQuery<StoryDetailResponse>({
    queryKey: ["story-detail", selectedSlug],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/stories/${selectedSlug}`);
      return response.json();
    },
    enabled: Boolean(selectedSlug),
  });

  const {
    data: storyAudioData,
    isFetching: audioFetching,
    refetch: refetchStoryAudio,
  } = useQuery<StoryAudioResponse>({
    queryKey: ["story-audio", selectedSlug, selectedVoiceProfile],
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/stories/${selectedSlug}/audio?voiceId=${encodeURIComponent(
          selectedVoiceProfile ?? ""
        )}`
      );
      return response.json();
    },
    enabled: Boolean(selectedSlug && selectedVoiceProfile),
  });

  useEffect(() => {
    if (!activeJob) {
      setJobStatus(null);
      return;
    }

    let isCancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await apiRequest("GET", `/api/jobs/${activeJob.jobId}`);
        const data: StoryJobStatus = await res.json();
        if (isCancelled) {
          return;
        }
        setJobStatus(data);

        if (data.state === "completed") {
          toast({
            title: "Story narration ready",
            description: "All sections have completed synthesis.",
          });
          queryClient.invalidateQueries({
            queryKey: ["story-audio", activeJob.slug, activeJob.voiceId],
          });
          setActiveJob(null);
          return;
        }

        if (data.state === "failed") {
          toast({
            title: "Narration failed",
            description: data.failedReason ?? "We could not complete the narration job.",
            variant: "destructive",
          });
          setActiveJob(null);
          return;
        }

        timeoutId = setTimeout(poll, 3000);
      } catch (error: any) {
        if (isCancelled) {
          return;
        }
        console.error("Failed to poll story job", error);
        timeoutId = setTimeout(poll, 5000);
      }
    };

    poll();

    return () => {
      isCancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [activeJob, queryClient]);

  useEffect(() => {
    if (categoryFilter !== "ALL" && filteredStories.length === 0 && stories.length > 0) {
      setCategoryFilter("ALL");
    }
  }, [filteredStories.length, stories.length, categoryFilter]);

  const mergedSections: StoryAudioSection[] = useMemo(() => {
    const baseSections: (StorySection & { audio?: StoryAudioEntry })[] =
      storyDetail?.sections ??
      storyAudioData?.sections ??
      [];

    const audioLookup = new Map(
      (storyAudioData?.sections ?? []).map((section) => [section.id, section.audio])
    );

    if (storyAudioData?.sections && storyDetail?.sections) {
      // ensure we have consistent ordering from detail response
      return storyDetail.sections.map((section) => ({
        ...section,
        audio: audioLookup.get(section.id) ?? EMPTY_AUDIO_ENTRY,
      }));
    }

    return baseSections.map((section) => ({
      ...section,
      audio: section.audio ?? audioLookup.get(section.id) ?? EMPTY_AUDIO_ENTRY,
    }));
  }, [storyDetail, storyAudioData]);

  const playableSections = useMemo(
    () => mergedSections.filter((s) => Boolean(s.audio?.audioUrl)),
    [mergedSections]
  );

  // Reset "Play All" when story or voice changes
  useEffect(() => {
    setIsPlayAll(false);
    setPlayIndex(0);
    if (playAllAudioRef.current) {
      playAllAudioRef.current.pause();
      playAllAudioRef.current.src = "";
    }
  }, [selectedSlug, selectedVoiceProfile]);

  // When Play All is toggled on, (re)start from current playIndex
  useEffect(() => {
    const audioEl = playAllAudioRef.current;
    if (!audioEl) return;
    if (!isPlayAll) return;
    const current = playableSections[playIndex];
    if (!current?.audio?.audioUrl) return;
    if (audioEl.src !== new URL(current.audio.audioUrl, window.location.origin).toString()) {
      audioEl.src = current.audio.audioUrl;
    }
    audioEl.play().catch(() => {
      // Autoplay might be blocked; keep controls visible for manual play
    });
  }, [isPlayAll, playIndex, playableSections]);

  const nextSection = () => {
    setPlayIndex((idx) => {
      const next = idx + 1;
      if (next >= playableSections.length) {
        setIsPlayAll(false);
        return idx;
      }
      return next;
    });
  };

  const prevSection = () => {
    setPlayIndex((idx) => Math.max(0, idx - 1));
  };

  const handlePlayAllToggle = () => {
    if (playableSections.length === 0) return;
    if (!isPlayAll) {
      // Start from first incomplete or current index
      setPlayIndex((idx) => (idx < playableSections.length ? idx : 0));
      setIsPlayAll(true);
    } else {
      setIsPlayAll(false);
      playAllAudioRef.current?.pause();
    }
  };

  const requestNarration = useMutation<ReadResponse, unknown, { force?: boolean }>({
    mutationFn: async ({ force }) => {
      if (!selectedSlug || !selectedVoiceProfile) {
        throw new Error("Select a story and voice profile first.");
      }
      const response = await apiRequest("POST", `/api/stories/${selectedSlug}/read`, {
        voiceId: selectedVoiceProfile,
        force,
      });
      return response.json();
    },
    onSuccess: (data) => {
      if (data.ready) {
        toast({
          title: "Narration ready",
          description: "We found completed sections for this story and voice.",
        });
        queryClient.invalidateQueries({
          queryKey: ["story-audio", data.story.slug, selectedVoiceProfile],
        });
        setActiveJob(null);
        setJobStatus(null);
        refetchStoryAudio();
        return;
      }

      if (!data.jobId) {
        toast({
          title: "Narration requested",
          description: "We queued this story for processing.",
        });
        return;
      }

      toast({
        title: "Narration queued",
        description:
          "We'll keep you posted as each section completes. You can stay on this page or come back later.",
      });
      setActiveJob({
        jobId: data.jobId,
        slug: data.story.slug,
        voiceId: selectedVoiceProfile!,
      });
      setJobStatus((prev) => ({
        id: data.jobId!,
        state: data.state ?? prev?.state ?? "waiting",
        progress: data.progress ?? prev?.progress ?? 0,
        attempts: prev?.attempts ?? 0,
        data: {
          storyId: data.story.id,
          voiceId: selectedVoiceProfile!,
        },
        failedReason: null,
        result: null,
        timestamp: prev?.timestamp ?? {
          createdAt: new Date().toISOString(),
          finishedAt: null,
        },
      }));
    },
    onError: (error) => {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as Error).message)
          : "We couldn't start narration. Please try again.";

      toast({
        title: "Narration failed",
        description: message,
        variant: "destructive",
      });
    },
  });

  const handleNarrate = (force?: boolean) => {
    if (!selectedVoiceProfile) {
      toast({
        title: "Select a voice",
        description: "Choose a voice profile before generating narration.",
        variant: "destructive",
      });
      return;
    }

    if (!selectedVoice || (selectedVoice.status && selectedVoice.status !== "ready")) {
      toast({
        title: "Voice not ready",
        description: "Pick a ready voice profile before generating narration.",
        variant: "destructive",
      });
      return;
    }

    requestNarration.mutate({ force });
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What are FamFlix Stories?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Stories are curated, age-appropriate scripts that families can personalize with AI voices and turn into narrated experiences inside FamFlix.",
        },
      },
      {
        "@type": "Question",
        name: "How do I generate narration for a story?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Choose your favorite voice profile, select a story, and click request narration. FamFlix will create an AI-read performance and notify you when it is ready.",
        },
      },
      {
        "@type": "Question",
        name: "Can I switch between different AI voices?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Absolutely. You can assign any approved family voice profile to a story and regenerate narration whenever you need a new performance.",
        },
      },
    ],
  } as const;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Seo
        title="Discover AI-narrated family stories"
        description="Browse curated FamFlix stories, pair them with cloned family voices, and request immersive narrations in seconds."
        canonical={`${BASE_URL}/stories`}
        openGraph={{
          type: "website",
          url: `${BASE_URL}/stories`,
          title: "Discover AI-narrated family stories | FamFlix",
          description:
            "Browse curated FamFlix stories, pair them with cloned family voices, and request immersive narrations in seconds.",
        }}
        twitter={{
          title: "Discover AI-narrated family stories | FamFlix",
          description:
            "Explore ready-made FamFlix story scripts and instantly generate narrated performances with your family's AI voices.",
        }}
        jsonLd={faqSchema}
      />
      <Navigation />
      <div className="container mx-auto px-4 pt-24 pb-10">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-foreground mb-3">Family Stories</h1>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Discover curated stories for every member of the family. Pick a voice
            you love and generate immersive narration with a single click.
          </p>
        </div>

        <Card className="bg-card border border-border">
          <CardHeader className="md:flex md:items-start md:justify-between gap-6">
            <div className="md:flex-1">
              <CardTitle className="text-foreground">Narration Voice</CardTitle>
              <CardDescription>
                Choose a voice profile to use when generating story narrations.
              </CardDescription>
            </div>
            <div className="md:w-64 lg:w-72 mt-4 md:mt-0 flex flex-col gap-4">
              <div>
                {voicesLoading ? (
                  <Skeleton className="h-10 w-full" />
                ) : voiceProfiles.length > 0 ? (
                  <Select
                    value={selectedVoiceProfile ?? undefined}
                    onValueChange={setSelectedVoiceProfile}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {voiceProfiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {(profile.displayName ?? profile.name) ||
                            profile.name}
                          {profile.status && profile.status !== "ready"
                            ? ` · ${profile.status}`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No voice profiles found. Visit the Voice Cloning studio to
                    create one.
                  </p>
                )}
              </div>
              {user?.plan === 'free' && (
                <AdBanner placementId="stories-sidebar" layout="sidebar" />
              )}
            </div>
          </CardHeader>
          <CardContent>
            {storiesLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : storiesError ? (
              <div className="text-center text-muted-foreground">
                We couldn't load stories right now. Please try again later.
              </div>
            ) : stories.length === 0 ? (
              <div className="text-center text-muted-foreground">
                No stories are available yet. Check back soon!
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="bg-secondary text-secondary-foreground">
                      {storiesResponse?.total ?? stories.length} stories
                    </Badge>
                    {selectedStorySummary && selectedVoiceProfile && (
                      <Badge variant="outline" className="bg-accent/20 text-accent border border-accent/40">
                        {selectedStorySummary.title} +{" "}
                        {(selectedVoice?.displayName ?? selectedVoice?.name) || "Voice"}
                      </Badge>
                    )}
                  </div>
                  <div className="w-full md:w-64">
                    <Select
                      value={categoryFilter}
                      onValueChange={(value) => setCategoryFilter(value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Filter by category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">All categories</SelectItem>
                        {categories.map((category) => (
                          <SelectItem key={category} value={category}>
                            {category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-[2fr,3fr]">
                  <div className="space-y-3">
                    {filteredStories.map((story) => {
                      const durationLabel = formatMinutes(story.durationMin);
                      const isSelected = story.slug === selectedSlug;
                      return (
                        <button
                          type="button"
                          key={story.id}
                          onClick={() => setSelectedSlug(story.slug)}
                          className={cn(
                            "w-full rounded-xl border border-border bg-card p-4 text-left transition hover:bg-secondary/30",
                            isSelected && "ring-1 ring-primary/60",
                            "hover:shadow-lg hover:border-primary/30"
                          )}
                        >
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between gap-2">
                              <h3 className="text-lg font-semibold text-foreground">
                                {story.title}
                              </h3>
                              <Badge variant="secondary" className="bg-secondary text-secondary-foreground">
                                {story.category || "UNCATEGORIZED"}
                              </Badge>
                            </div>
                            {story.summary ? (
                              <p className="text-sm text-muted-foreground line-clamp-3">
                                {story.summary}
                              </p>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              {durationLabel && <span>{durationLabel}</span>}
                              {story.ageRange?.min !== null ||
                              story.ageRange?.max !== null ? (
                                <span>
                                  Ages{" "}
                                  {story.ageRange.min ?? "?"}-
                                  {story.ageRange.max ?? "?"}
                                </span>
                              ) : null}
                              {story.tags.slice(0, 3).map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="outline"
                                  className="border-border bg-secondary text-secondary-foreground"
                                >
                                  #{tag}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="rounded-xl border border-border bg-card p-6">
                    {!selectedStorySummary ? (
                      <div className="text-center text-muted-foreground">
                        Select a story to explore its sections.
                      </div>
                    ) : detailLoading ? (
                      <div className="space-y-6">
                        <div className="space-y-3">
                          <Skeleton className="h-8 w-3/4" />
                          <Skeleton className="h-4 w-1/2" />
                          <div className="flex flex-wrap gap-2">
                            <Skeleton className="h-6 w-24" />
                            <Skeleton className="h-6 w-24" />
                          </div>
                          <Skeleton className="h-16 w-full" />
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Skeleton className="h-10 w-32" />
                          <Skeleton className="h-10 w-32" />
                          <Skeleton className="h-10 w-24" />
                        </div>
                        <div className="space-y-4">
                          <Skeleton className="h-6 w-1/3" />
                          <Skeleton className="h-24 w-full" />
                          <Skeleton className="h-24 w-full" />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <h2 className="text-2xl font-semibold text-foreground">
                                {selectedStorySummary.title}
                              </h2>
                              {selectedStorySummary.author && (
                                <p className="text-sm text-muted-foreground">
                                  By {selectedStorySummary.author}
                                </p>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Badge variant="outline" className="border-border bg-secondary text-secondary-foreground">
                                {selectedStorySummary.category}
                              </Badge>
                              <Badge variant="outline" className="border-border bg-secondary text-secondary-foreground">
                                Rights: {selectedStorySummary.rights}
                              </Badge>
                            </div>
                          </div>
                          {selectedStorySummary.summary && (
                            <p className="text-sm text-muted-foreground leading-relaxed">
                              {selectedStorySummary.summary}
                            </p>
                          )}
                          {selectedStorySummary.tags.length > 0 && (
                            <div className="flex flex-wrap gap-2 text-xs">
                              {selectedStorySummary.tags.map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="outline"
                                  className="border-border bg-secondary text-secondary-foreground"
                                >
                                  #{tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          {/* Full Story Player */}
                          <div className="w-full rounded-md border border-border bg-card p-3 md:w-auto md:flex md:items-center md:gap-3">
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant={isPlayAll ? "secondary" : "default"}
                                onClick={handlePlayAllToggle}
                                disabled={playableSections.length === 0}
                              >
                                {isPlayAll ? (
                                  <span className="flex items-center gap-2">
                                    <i className="fas fa-pause" /> Pause All
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-2">
                                    <i className="fas fa-play" /> Play All
                                  </span>
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={prevSection}
                                disabled={playableSections.length === 0 || playIndex === 0}
                              >
                                <i className="fas fa-backward" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={nextSection}
                                disabled={playableSections.length === 0 || playIndex >= playableSections.length - 1}
                              >
                                <i className="fas fa-forward" />
                              </Button>
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground md:mt-0 md:ml-3">
                              {playableSections.length > 0 ? (
                                <span>
                                  Section {Math.min(playIndex + 1, playableSections.length)} / {playableSections.length}
                                </span>
                              ) : (
                                <span>No generated audio yet</span>
                              )}
                            </div>
                            {/* Hidden but usable audio element for Play All */}
                            <audio
                              ref={playAllAudioRef}
                              className="mt-2 w-full md:hidden"
                              controls
                              preload="none"
                              onEnded={nextSection}
                              onError={nextSection}
                            />
                            {/* Download full story */}
                            <div className="mt-2 md:mt-0 md:ml-3">
                              <Button
                                size="sm"
                                variant="outline"
                                asChild
                                disabled={!selectedSlug || !selectedVoiceProfile || playableSections.length === 0}
                              >
                                <a
                                  href={`/api/stories/${selectedSlug}/download/full?voiceId=${encodeURIComponent(
                                    selectedVoiceProfile ?? ''
                                  )}`}
                                >
                                  <i className="fas fa-download mr-2" /> Download All
                                </a>
                              </Button>
                            </div>
                          </div>

                          <Button
                            onClick={() => handleNarrate(false)}
                            disabled={Boolean(
                              !selectedVoiceProfile ||
                              voicesLoading ||
                              requestNarration.isPending ||
                              Boolean(activeJob) ||
                              (!!selectedVoice?.status && selectedVoice.status !== "ready")
                            )}
                          >
                            {requestNarration.isPending || activeJob ? (
                              <span className="flex items-center gap-2">
                                <i className="fas fa-circle-notch animate-spin" />
                                Generating narration...
                              </span>
                            ) : (
                              <span className="flex items-center gap-2">
                                <i className="fas fa-magic" />
                                Read with{" "}
                                {(selectedVoice?.displayName ?? selectedVoice?.name) ||
                                  "selected voice"}
                              </span>
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => handleNarrate(true)}
                            disabled={
                              !selectedVoiceProfile ||
                              voicesLoading ||
                              requestNarration.isPending ||
                              Boolean(activeJob)
                            }
                          >
                            Regenerate audio
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              if (selectedSlug && selectedVoiceProfile) {
                                refetchStoryAudio();
                              }
                            }}
                            disabled={!selectedSlug || !selectedVoiceProfile || audioFetching}
                          >
                            Refresh status
                          </Button>
                        </div>

                        {jobStatus && (
                          <div className="rounded-lg border border-border bg-card p-4 space-y-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-medium text-foreground">
                                Synthesis progress
                              </span>
                              <Badge
                                variant="outline"
                                className={jobStateBadge(jobStatus.state)}
                              >
                                {JOB_STATE_LABEL[jobStatus.state] ?? jobStatus.state}
                              </Badge>
                            </div>
                            <Progress value={jobStatus.progress ?? 0} />
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>Job ID: {jobStatus.id}</span>
                              <span>{Math.round(jobStatus.progress ?? 0)}%</span>
                            </div>
                            {jobStatus.failedReason && (
                              <p className="text-xs text-destructive">
                                {jobStatus.failedReason}
                              </p>
                            )}
                          </div>
                        )}

                        <>
                          {storyDetail?.content && (
                            <div className="rounded-lg border border-border bg-card p-4 text-sm whitespace-pre-wrap leading-relaxed">
                              {storyDetail.content}
                            </div>
                          )}

                          <div className="space-y-4">
                            <h3 className="text-lg font-semibold text-foreground">
                              Sections &amp; audio
                            </h3>
                            {mergedSections.length === 0 ? (
                              <p className="text-sm text-slate-300">
                                We could not load story sections yet. Try refreshing the page.
                              </p>
                            ) : (
                              <div className="space-y-4">
                                {mergedSections.map((section, index) => {
                                  const status =
                                    section.audio.status ?? "PENDING";
                                  const badgeClass =
                                    STATUS_BADGE_CLASS[status] ??
                                    STATUS_BADGE_CLASS.PENDING;
                                  return (
                                    <div
                                      key={section.id}
                                      className="rounded-lg border border-border bg-card p-4 space-y-3"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div>
                                          <p className="text-sm font-semibold text-foreground">
                                            Section {index + 1}
                                            {section.title ? ` · ${section.title}` : ""}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            Words: {section.wordCount}
                                          </p>
                                        </div>
                                        <Badge variant="outline" className={badgeClass}>
                                          {status}
                                        </Badge>
                                      </div>
                                      {section.text && (
                                        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                                          {section.text}
                                        </p>
                                      )}
                                      {section.audio.audioUrl ? (
                                        <audio
                                          controls
                                          preload="none"
                                          className="w-full"
                                          src={section.audio.audioUrl}
                                        />
                                      ) : (
                                        <p className="text-xs text-slate-400">
                                          Audio will appear here once generation completes.
                                        </p>
                                      )}
                                      {section.audio.audioUrl && (
                                        <div className="pt-1">
                                          <Button size="sm" variant="outline" asChild>
                                            <a
                                              href={`/api/stories/${selectedStorySummary?.slug}/download/section/${section.id}?voiceId=${encodeURIComponent(
                                                selectedVoiceProfile ?? ''
                                              )}`}
                                            >
                                              <i className="fas fa-download mr-2" /> Download Section
                                            </a>
                                          </Button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
