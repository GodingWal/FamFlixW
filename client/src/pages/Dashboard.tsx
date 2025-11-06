import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Navigation } from "@/components/Navigation";
import AdBanner from "@/components/AdBanner";
import { VideoCard } from "@/components/VideoCard";
import { QuickActionCard } from "@/components/QuickActionCard";
import { CollaboratorCard } from "@/components/CollaboratorCard";
import { useAuth } from "@/hooks/useAuth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  const { user } = useAuth();

  const { data: videos, isLoading: videosLoading } = useQuery({
    queryKey: ["/api/videos"],
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
  });

  const { data: families } = useQuery({
    queryKey: ["/api/families"],
  });

  const { data: activities } = useQuery({
    queryKey: ["/api/families", Array.isArray(families) ? families[0]?.id : null, "activities"],
    enabled: Boolean(families && Array.isArray(families) && families[0]?.id),
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      
      {/* Hero Section */}
      <main className="pt-16">
        <section className="relative overflow-hidden bg-gradient-to-br from-background via-background to-secondary py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center animate-fade-in">
              <h2 className="text-5xl md:text-6xl font-bold gradient-text mb-6">
                Create Magical
                <br />
                Family Videos
              </h2>
              <p className="text-xl text-muted-foreground mb-8 max-w-3xl mx-auto">
                Transform your family memories with AI-powered voice cloning, collaborative editing, and stunning video creation tools designed for families.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/create">
                  <Button size="lg" className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="button-start-creating">
                    <i className="fas fa-play mr-2"></i>
                    Start Creating
                  </Button>
                </Link>
                <Link href="/stories">
                  <Button variant="secondary" size="lg" data-testid="button-watch-demo">
                    <i className="fas fa-video mr-2"></i>
                    Watch Demo
                  </Button>
                </Link>
              </div>
            </div>
          </div>
          <div className="absolute top-20 right-10 w-32 h-32 bg-primary/20 rounded-full blur-xl animate-float"></div>
          <div className="absolute bottom-20 left-10 w-24 h-24 bg-accent/20 rounded-full blur-xl animate-float" style={{animationDelay: '1s'}}></div>
        </section>
      </main>

      {/* Quick Actions */}
      <section className="py-16 bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <QuickActionCard
              icon="fas fa-microphone"
              title="Record Voice"
              description="Capture family voices for AI cloning"
              href="/voice-cloning"
              iconColor="text-primary"
              bgColor="bg-primary/20"
            />
            <QuickActionCard
              icon="fas fa-robot"
              title="AI Clone"
              description="Create AI voice duplicates instantly"
              href="/voice-cloning"
              iconColor="text-accent"
              bgColor="bg-accent/20"
            />
            <QuickActionCard
              icon="fas fa-video"
              title="Create Video"
              description="Generate family stories with AI"
              href="/create"
              iconColor="text-primary"
              bgColor="bg-primary/20"
            />
            <QuickActionCard
              icon="fas fa-users"
              title="Collaborate"
              description="Work together in real-time"
              href="/videos"
              iconColor="text-accent"
              bgColor="bg-accent/20"
            />
          </div>
        </div>
      </section>

      {/* Video Library */}
      <section className="py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between mb-8">
            <div>
              <h2 className="text-3xl font-bold mb-2">Your Family Library</h2>
              <p className="text-muted-foreground">Recent videos and ongoing projects</p>
            </div>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6 w-full lg:w-auto">
              {user?.plan === 'free' && (
                <div className="w-full lg:w-80">
                  <AdBanner placementId="dashboard-library" layout="sidebar" />
                </div>
              )}
              <Link href="/create" className="lg:self-end">
                <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="button-new-project">
                  <i className="fas fa-plus mr-2"></i>
                  New Project
                </Button>
              </Link>
            </div>
          </div>

          {videosLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-card rounded-xl h-64 animate-pulse" />
              ))}
            </div>
          ) : Array.isArray(videos) && videos.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {(videos || []).slice(0, 6).map((video: any) => (
                <VideoCard key={video.id} video={video} />
              ))}
            </div>
          ) : (
            <div className="text-center py-12" data-testid="text-no-videos">
              <i className="fas fa-video text-4xl text-muted-foreground mb-4"></i>
              <h3 className="text-lg font-semibold mb-2">No videos yet</h3>
              <p className="text-muted-foreground mb-4">Start creating your first family video</p>
              <Link href="/create">
                <Button data-testid="button-create-first-video">Create Your First Video</Button>
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* Real-time Collaboration */}
      {Array.isArray(activities) && activities.length > 0 && (
        <section className="py-16 bg-gradient-to-r from-primary/10 to-accent/10">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold mb-4">Recent Family Activity</h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">See what your family members have been creating and sharing.</p>
            </div>

            <div className="bg-card rounded-xl p-8 shadow-lg">
              <div className="space-y-3">
                {(activities || []).slice(0, 5).map((activity: any, index: number) => (
                  <div key={activity.id} className="flex items-center space-x-3 text-sm">
                    <div className="w-8 h-8 bg-primary/20 rounded-full flex items-center justify-center">
                      <i className={`fas ${getActivityIcon(activity.action)} text-primary text-xs`}></i>
                    </div>
                    <div className="flex-1">
                      <span className="font-medium">{activity.user?.firstName || 'Someone'}</span> {getActivityText(activity.action)} <span className="text-primary">{activity.details?.title || 'a project'}</span>
                    </div>
                    <span className="text-muted-foreground">{formatTimeAgo(activity.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function getActivityIcon(action: string): string {
  switch (action) {
    case 'create_video': return 'fa-video';
    case 'update_video': return 'fa-edit';
    case 'join_collaboration': return 'fa-users';
    case 'create_voice_profile': return 'fa-microphone';
    default: return 'fa-activity';
  }
}

function getActivityText(action: string): string {
  switch (action) {
    case 'create_video': return 'created a new video';
    case 'update_video': return 'updated';
    case 'join_collaboration': return 'started collaborating on';
    case 'create_voice_profile': return 'created a voice profile for';
    default: return 'worked on';
  }
}

function formatTimeAgo(date: string): string {
  const now = new Date();
  const past = new Date(date);
  const diffInMinutes = Math.floor((now.getTime() - past.getTime()) / (1000 * 60));

  if (Number.isNaN(diffInMinutes) || diffInMinutes < 1) {
    return 'just now';
  }

  const pluralize = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? '' : 's'} ago`;

  if (diffInMinutes < 60) {
    return pluralize(diffInMinutes, 'minute');
  }

  const hours = Math.floor(diffInMinutes / 60);
  if (hours < 24) {
    return pluralize(hours, 'hour');
  }

  const days = Math.floor(diffInMinutes / 1440);
  if (days < 7) {
    return pluralize(days, 'day');
  }

  const weeks = Math.floor(diffInMinutes / (1440 * 7));
  if (weeks < 5) {
    return pluralize(weeks, 'week');
  }

  const months = Math.floor(diffInMinutes / (1440 * 30));
  if (months < 12) {
    return pluralize(months, 'month');
  }

  const years = Math.floor(diffInMinutes / (1440 * 365));
  return pluralize(Math.max(years, 1), 'year');
}
