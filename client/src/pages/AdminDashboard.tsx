import React, { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/hooks/useAuth';
import { Redirect } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Users,
  Video,
  Mic,
  Upload,
  TrendingUp,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  LayoutDashboard,
  Sparkles,
  BarChart3,
  ShieldCheck,
  ArrowUpRight,
  Book
} from 'lucide-react';
import { Link } from 'wouter';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

type AdminStats = {
  totalUsers: number;
  totalVideos: number;
  totalVoiceClones: number;
  totalTemplateVideos: number;
  activeVoiceJobs: number;
  completedVoiceJobs: number;
  failedVoiceJobs: number;
  recentUsers: Array<{
    id: string;
    email: string;
    created_at: string;
    role: string;
  }>;
  recentVoiceJobs: Array<{
    id: string;
    name: string;
    status: string;
    created_at: string;
    user_email: string;
  }>;
  recentTemplateVideos: Array<{
    id: string;
    title: string;
    created_at: string;
    category: string;
  }>;
};

type ManagedUser = {
  id: string;
  email: string;
  role: 'user' | 'admin';
  created_at: string;
  voice_jobs_count: number;
  voice_profiles_count: number;
};

type SystemHealth = {
  database: boolean;
  tts: boolean;
  timestamp: string;
  uptime: number;
};

const AdminDashboard: React.FC = () => {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: stats, isLoading, error } = useQuery<AdminStats>({
    queryKey: ['adminStats'],
    queryFn: async () => {
      const response = await axios.get('/api/admin/stats');
      return response.data;
    },
    refetchInterval: 30000, // Refresh every 30 seconds
    enabled: isAuthenticated && user?.role === 'admin',
  });

  const { data: managedUsers = [], isLoading: usersLoading } = useQuery<ManagedUser[]>({
    queryKey: ['adminUsers'],
    queryFn: async () => {
      const response = await axios.get('/api/admin/users');
      return response.data;
    },
    enabled: isAuthenticated && user?.role === 'admin',
    refetchInterval: 60000,
  });

  const { data: systemHealth, isLoading: healthLoading } = useQuery<SystemHealth>({
    queryKey: ['adminHealth'],
    queryFn: async () => {
      const response = await axios.get('/api/admin/health');
      return response.data;
    },
    enabled: isAuthenticated && user?.role === 'admin',
    refetchInterval: 60000,
  });

  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const updateUserRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'user' | 'admin' }) => {
      await axios.patch(`/api/admin/users/${userId}/role`, { role });
    },
    onMutate: ({ userId }) => {
      setUpdatingUserId(userId);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['adminUsers'] });
      toast({
        title: 'Role updated',
        description: `User role set to ${variables.role}.`,
      });
    },
    onError: (mutationError) => {
      console.error('Failed to update user role', mutationError);
      toast({
        title: 'Failed to update role',
        description: 'Please try again in a moment.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setUpdatingUserId(null);
    },
  });

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-100 text-green-800"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
      case 'failed':
        return <Badge className="bg-red-100 text-red-800"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
      case 'processing':
        return <Badge className="bg-yellow-100 text-yellow-800"><Clock className="h-3 w-3 mr-1" />Processing</Badge>;
      default:
        return <Badge className="bg-gray-100 text-gray-800">{status}</Badge>;
    }
  };

  const quickActions = [
    {
      title: 'Upload Templates',
      description: 'Add new curated templates to the public catalog.',
      href: '/admin/upload-templates',
      icon: Upload,
    },
    {
      title: 'Upload Stories',
      description: 'Publish new markdown stories for the library.',
      href: '/admin/upload-story',
      icon: Book,
    },
    {
      title: 'Monitor Voice Jobs',
      description: 'Track cloning progress and troubleshoot failures.',
      href: '/voice-cloning',
      icon: Mic,
    },
    {
      title: 'Review Catalog',
      description: 'Preview how families experience the template library.',
      href: '/video-selection',
      icon: LayoutDashboard,
    },
  ];

  const activeVoiceJobs = stats?.activeVoiceJobs ?? 0;
  const completedVoiceJobs = stats?.completedVoiceJobs ?? 0;
  const failedVoiceJobs = stats?.failedVoiceJobs ?? 0;
  const totalVoiceJobs = activeVoiceJobs + completedVoiceJobs + failedVoiceJobs;
  const voiceJobCompletion = totalVoiceJobs ? Math.round((completedVoiceJobs / totalVoiceJobs) * 100) : 0;
  const voiceJobFailure = totalVoiceJobs ? Math.round((failedVoiceJobs / totalVoiceJobs) * 100) : 0;
  const formatUptime = (uptimeSeconds?: number) => {
    if (!uptimeSeconds || uptimeSeconds <= 0) {
      return 'Refreshing...';
    }
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor(uptimeSeconds % 60);
    const parts: string[] = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (!hours && !minutes) parts.push(`${seconds}s`);
    return parts.join(' ');
  };

  const healthIndicators = [
    {
      key: 'database',
      label: 'Database',
      healthy: systemHealth?.database ?? false,
      description: 'Primary datastore connectivity',
    },
    {
      key: 'tts',
      label: 'TTS Engine',
      healthy: systemHealth?.tts ?? false,
      description: 'Voice synthesis integration',
    },
  ];

  const alerts: Array<{ severity: 'critical' | 'warning' | 'info'; title: string; description: string }> = [];

  if (failedVoiceJobs > 0) {
    alerts.push({
      severity: 'critical',
      title: 'Voice jobs requiring attention',
      description: `${failedVoiceJobs} job${failedVoiceJobs === 1 ? '' : 's'} failed in the last cycle.`,
    });
  }

  if (systemHealth && !systemHealth.database) {
    alerts.push({
      severity: 'critical',
      title: 'Database connectivity issue',
      description: 'Recent checks failed to reach the primary database.',
    });
  }

  if (systemHealth && !systemHealth.tts) {
    alerts.push({
      severity: 'warning',
      title: 'TTS Engine unavailable',
      description: 'Voice synthesis may be delayed until the TTS engine is available.',
    });
  }

  if (stats && stats.totalTemplateVideos < 6) {
    alerts.push({
      severity: 'info',
      title: 'Template library running light',
      description: 'Consider uploading fresh templates to keep the catalog vibrant.',
    });
  }

  const handleRefreshUsers = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['adminUsers'] });
  }, [queryClient]);

  const handleExportUsers = useCallback(() => {
    if (!managedUsers.length) {
      toast({
        title: 'Nothing to export',
        description: 'Load the team directory before exporting.',
      });
      return;
    }

    const headers = ['Email', 'Role', 'Voice Jobs', 'Voice Profiles', 'Joined'];
    const rows = managedUsers.map((managedUser) => [
      managedUser.email,
      managedUser.role,
      managedUser.voice_jobs_count,
      managedUser.voice_profiles_count,
      new Date(managedUser.created_at).toISOString(),
    ]);

    const csv = [headers, ...rows]
      .map((row) =>
        row
          .map((cell) => {
            const value = String(cell ?? '');
            return `"${value.replace(/"/g, '""')}"`;
          })
          .join(',')
      )
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `famflixr-users-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast({
      title: 'Export ready',
      description: `Downloaded ${managedUsers.length} user record${managedUsers.length === 1 ? '' : 's'}.`,
    });
  }, [managedUsers, toast]);

  const handleRoleChange = useCallback(
    (managedUser: ManagedUser, role: 'user' | 'admin') => {
      if (managedUser.role === role) return;
      updateUserRole.mutate({ userId: managedUser.id, role });
    },
    [updateUserRole]
  );

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!isAuthenticated || user?.role !== 'admin') {
    return <Redirect to="/" />;
  }

  if (error) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-red-600 mb-2">Error Loading Dashboard</h2>
          <p className="text-gray-600">Failed to load admin statistics. Please try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <div className="container mx-auto space-y-10 py-8">
        <section className="relative overflow-hidden rounded-3xl border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-8 shadow-sm">
          <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-primary/20 blur-3xl lg:block" />
          <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Administrative Control Center
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">
                Welcome back, {user?.email}
              </h1>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                Monitor platform health, manage premium experiences, and keep families delighted with fresh content and reliable voice services.
              </p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
              <Button variant="outline" asChild>
                <Link href="/admin/upload-templates">
                  <Upload className="mr-2 h-4 w-4" />
                  Upload Templates
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/admin/upload-story">
                  <Book className="mr-2 h-4 w-4" />
                  Upload Stories
                </Link>
              </Button>
              <Button variant="ghost" className="gap-2" asChild>
                <Link href="/voice-cloning">
                  <Sparkles className="h-4 w-4" />
                  Voice Studio
                </Link>
              </Button>
            </div>
          </div>

          <div className="relative z-10 mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quickActions.map((action) => (
              <Link
                key={action.title}
                href={action.href}
                className="group block rounded-2xl border border-transparent bg-card/80 p-4 shadow-sm transition hover:border-primary/40 hover:shadow-md"
              >
                <div className="flex items-start justify-between">
                  <div className="rounded-full bg-primary/10 p-2 text-primary">
                    <action.icon className="h-4 w-4" />
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground transition group-hover:text-primary" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-foreground">{action.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{action.description}</p>
              </Link>
            ))}
          </div>
        </section>

        {isLoading ? (
          <div className="grid gap-6 lg:grid-cols-12">
            {[...Array(4)].map((_, i) => (
              <Card key={i} className="animate-pulse lg:col-span-3">
                <CardContent className="p-6">
                  <div className="mb-4 h-4 w-24 rounded bg-muted" />
                  <div className="h-10 w-16 rounded bg-muted" />
                </CardContent>
              </Card>
            ))}
            <Card className="animate-pulse lg:col-span-8">
              <CardContent className="p-6 space-y-3">
                <div className="h-5 w-32 rounded bg-muted" />
                <div className="h-4 w-full rounded bg-muted" />
                <div className="h-4 w-3/5 rounded bg-muted" />
                <div className="h-4 w-2/5 rounded bg-muted" />
              </CardContent>
            </Card>
            <Card className="animate-pulse lg:col-span-4">
              <CardContent className="p-6 space-y-3">
                <div className="h-5 w-28 rounded bg-muted" />
                <div className="h-4 w-full rounded bg-muted" />
                <div className="h-4 w-3/4 rounded bg-muted" />
              </CardContent>
            </Card>
          </div>
        ) : (
          stats && (
            <>
              <section className="grid gap-6 lg:grid-cols-12">
                <div className="space-y-6 lg:col-span-8">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <Card className="relative overflow-hidden">
                      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-primary/40 to-transparent" />
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Users</CardTitle>
                        <Users className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-semibold tracking-tight">{stats.totalUsers}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <TrendingUp className="mr-1 inline h-3 w-3 text-primary" />
                          Growing community footprint
                        </p>
                      </CardContent>
                    </Card>

                    <Card className="relative overflow-hidden">
                      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 via-emerald-300/60 to-transparent" />
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Template Library</CardTitle>
                        <Video className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-semibold tracking-tight">{stats.totalTemplateVideos}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Ready-to-use storytelling experiences
                        </p>
                      </CardContent>
                    </Card>

                    <Card className="relative overflow-hidden">
                      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 via-sky-400/60 to-transparent" />
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Voice Clones</CardTitle>
                        <Mic className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-semibold tracking-tight">{stats.totalVoiceClones}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Personalized voices created to date
                        </p>
                      </CardContent>
                    </Card>

                    <Card className="relative overflow-hidden">
                      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500 via-amber-300/60 to-transparent" />
                      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Voice Jobs</CardTitle>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-semibold tracking-tight">{activeVoiceJobs}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {completedVoiceJobs} completed • {failedVoiceJobs} failed
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  <Card>
                    <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <CardTitle className="text-base font-semibold">Voice Job Pipeline</CardTitle>
                        <CardDescription>Realtime overview of processing health and throughput.</CardDescription>
                      </div>
                      <Badge variant="outline" className="gap-1 text-xs">
                        <BarChart3 className="h-3 w-3" />
                        {totalVoiceJobs} total jobs
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div>
                        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                          <span>Completion Rate</span>
                          <span>{voiceJobCompletion}%</span>
                        </div>
                        <Progress value={voiceJobCompletion} className="mt-2 h-2" />
                      </div>

                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="rounded-lg border bg-muted/10 p-4">
                          <p className="text-xs text-muted-foreground">Active</p>
                          <p className="mt-1 text-xl font-semibold">{activeVoiceJobs}</p>
                          <p className="text-xs text-muted-foreground">
                            Jobs currently synthesizing voices
                          </p>
                        </div>
                        <div className="rounded-lg border bg-muted/10 p-4">
                          <p className="text-xs text-muted-foreground">Completed</p>
                          <p className="mt-1 text-xl font-semibold">{completedVoiceJobs}</p>
                          <p className="text-xs text-muted-foreground">
                            {voiceJobCompletion}% success rate
                          </p>
                        </div>
                        <div className="rounded-lg border bg-muted/10 p-4">
                          <p className="text-xs text-muted-foreground">Failed</p>
                          <p className="mt-1 text-xl font-semibold text-red-500">{failedVoiceJobs}</p>
                          <p className="text-xs text-muted-foreground">
                            {voiceJobFailure}% require attention
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="space-y-6 lg:col-span-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>Platform Snapshot</CardTitle>
                      <CardDescription>High-level checks to monitor overall stability.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <div className="flex items-center gap-3">
                        <div className="rounded-full bg-emerald-500/10 p-2 text-emerald-500">
                          <CheckCircle className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">Services Operational</p>
                          <p className="text-xs text-muted-foreground">
                            All core services responding within expected latency.
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="rounded-full bg-blue-500/10 p-2 text-blue-500">
                          <Users className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">New Families Onboarded</p>
                          <p className="text-xs text-muted-foreground">
                            {stats.recentUsers.length
                              ? `${stats.recentUsers.length} users joined recently`
                              : 'No new sign-ups in the last cycle'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="rounded-full bg-amber-500/10 p-2 text-amber-500">
                          <Video className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">Template Coverage</p>
                          <p className="text-xs text-muted-foreground">
                            {stats.totalTemplateVideos} templates across all categories.
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>System Health</CardTitle>
                      <CardDescription>Latest monitoring check-ins across critical services.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {healthLoading ? (
                        <div className="space-y-3">
                          {[...Array(2)].map((_, index) => (
                            <Skeleton key={index} className="h-10 w-full" />
                          ))}
                        </div>
                      ) : (
                        <>
                          {healthIndicators.map((indicator) => {
                            const healthy = indicator.healthy;
                            return (
                              <div key={indicator.key} className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/10 p-3">
                                <div
                                  className={`mt-1 rounded-full p-1.5 ${
                                    healthy ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                                  }`}
                                >
                                  {healthy ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                                </div>
                                <div>
                                  <p className="text-sm font-semibold text-foreground">{indicator.label}</p>
                                  <p className="text-xs text-muted-foreground">{indicator.description}</p>
                                </div>
                              </div>
                            );
                          })}
                          <div className="rounded-lg bg-primary/5 p-3 text-xs text-muted-foreground">
                            <p className="font-medium text-foreground">Heartbeat</p>
                            <p>
                              Uptime: {formatUptime(systemHealth?.uptime)} • Last check:{' '}
                              {systemHealth ? new Date(systemHealth.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                            </p>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Operational Alerts</CardTitle>
                      <CardDescription>Action items generated from recent activity.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {alerts.length === 0 ? (
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                          <p className="font-medium">No outstanding alerts</p>
                          <p className="text-xs text-emerald-600">You’re all caught up. Keep an eye here for anything that needs attention.</p>
                        </div>
                      ) : (
                        alerts.map((alert, index) => {
                          const palette =
                            alert.severity === 'critical'
                              ? 'border-red-200 bg-red-50 text-red-700'
                              : alert.severity === 'warning'
                              ? 'border-amber-200 bg-amber-50 text-amber-700'
                              : 'border-blue-200 bg-blue-50 text-blue-700';
                          return (
                            <div key={`${alert.title}-${index}`} className={`rounded-lg border p-3 text-sm ${palette}`}>
                              <p className="font-medium">{alert.title}</p>
                              <p className="text-xs opacity-90">{alert.description}</p>
                            </div>
                          );
                        })
                      )}
                    </CardContent>
                  </Card>
                </div>
              </section>

              <section className="grid gap-6 lg:grid-cols-12">
                <Card className="lg:col-span-8">
                  <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <CardTitle>Team Management</CardTitle>
                      <CardDescription>Promote trusted collaborators and keep an eye on platform activity.</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={handleRefreshUsers} disabled={usersLoading}>
                        Refresh
                      </Button>
                      <Button variant="ghost" size="sm" onClick={handleExportUsers} disabled={usersLoading}>
                        Export CSV
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {usersLoading ? (
                      <div className="space-y-3">
                        {[...Array(4)].map((_, index) => (
                          <Skeleton key={index} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Email</TableHead>
                            <TableHead>Role</TableHead>
                            <TableHead className="hidden md:table-cell">Voice Jobs</TableHead>
                            <TableHead className="hidden md:table-cell">Voice Profiles</TableHead>
                            <TableHead className="hidden lg:table-cell">Joined</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {managedUsers.length ? (
                            managedUsers.slice(0, 8).map((managedUser) => (
                              <TableRow key={managedUser.id}>
                                <TableCell className="font-medium">{managedUser.email}</TableCell>
                                <TableCell>
                                  <Select
                                    value={managedUser.role}
                                    onValueChange={(value) => handleRoleChange(managedUser, value as 'user' | 'admin')}
                                    disabled={updatingUserId === managedUser.id}
                                  >
                                    <SelectTrigger className="w-[140px]">
                                      <SelectValue placeholder="Role" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="user">Standard User</SelectItem>
                                      <SelectItem value="admin">Administrator</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                                <TableCell className="hidden md:table-cell">{managedUser.voice_jobs_count}</TableCell>
                                <TableCell className="hidden md:table-cell">{managedUser.voice_profiles_count}</TableCell>
                                <TableCell className="hidden lg:table-cell">
                                  {formatDate(managedUser.created_at)}
                                </TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <TableRow>
                              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                                No users loaded yet.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Need to onboard a teammate? Run the{' '}
                      <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">makeAdmin.ts</code> script or
                      promote them directly above. Changes take effect immediately.
                    </p>
                  </CardContent>
                </Card>

                <Card className="lg:col-span-4">
                  <CardHeader>
                    <CardTitle>Admin Toolkit</CardTitle>
                    <CardDescription>Frequently used workflows and supporting resources.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Button asChild variant="secondary" className="w-full justify-start gap-2">
                      <Link href="/admin/upload-templates">
                        <Upload className="h-4 w-4" />
                        Curate Template Library
                      </Link>
                    </Button>
                    <Button asChild variant="secondary" className="w-full justify-start gap-2">
                      <Link href="/voice-cloning">
                        <Mic className="h-4 w-4" />
                        Monitor Voice Studio
                      </Link>
                    </Button>
                    <Button asChild variant="secondary" className="w-full justify-start gap-2">
                      <Link href="/video-selection">
                        <LayoutDashboard className="h-4 w-4" />
                        Preview Family Catalog
                      </Link>
                    </Button>
                    <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">Need deeper insights?</p>
                      <p>
                        Ping the engineering channel with the latest metrics export or jump into{' '}
                        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">server/services</code> to adjust automations.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </section>

              <section className="grid gap-6 lg:grid-cols-3">
                <Card>
                  <CardHeader>
                    <CardTitle>Recent Users</CardTitle>
                    <CardDescription>Latest members joining the FamFlixR community.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y divide-border/60">
                      {stats.recentUsers.length ? (
                        stats.recentUsers.slice(0, 5).map((recentUser) => (
                          <div key={recentUser.id} className="flex items-center justify-between py-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{recentUser.email}</p>
                              <p className="text-xs text-muted-foreground">
                                {formatDate(recentUser.created_at)}
                              </p>
                            </div>
                            <Badge variant={recentUser.role === 'admin' ? 'default' : 'secondary'}>
                              {recentUser.role}
                            </Badge>
                          </div>
                        ))
                      ) : (
                        <p className="py-6 text-sm text-muted-foreground">No recent users to display.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Recent Voice Jobs</CardTitle>
                    <CardDescription>Insight into the most recent cloning activity.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y divide-border/60">
                      {stats.recentVoiceJobs.length ? (
                        stats.recentVoiceJobs.slice(0, 5).map((job) => (
                          <div key={job.id} className="flex items-center justify-between py-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{job.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {job.user_email} • {formatDate(job.created_at)}
                              </p>
                            </div>
                            {getStatusBadge(job.status)}
                          </div>
                        ))
                      ) : (
                        <p className="py-6 text-sm text-muted-foreground">No voice jobs yet.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Recent Template Videos</CardTitle>
                    <CardDescription>Fresh launches ready for families to explore.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="divide-y divide-border/60">
                      {stats.recentTemplateVideos.length ? (
                        stats.recentTemplateVideos.slice(0, 5).map((video) => (
                          <div key={video.id} className="flex items-center justify-between py-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{video.title}</p>
                              <p className="text-xs text-muted-foreground">
                                {video.category} • {formatDate(video.created_at)}
                              </p>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="py-6 text-sm text-muted-foreground">No new templates published.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </section>
            </>
          )
        )}
      </div>
    </div>
  );
};

export default AdminDashboard;
