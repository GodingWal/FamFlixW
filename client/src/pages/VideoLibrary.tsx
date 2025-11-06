import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Navigation } from "@/components/Navigation";
import AdBanner from "@/components/AdBanner";
import { VideoCard } from "@/components/VideoCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { shareVideo } from "@/lib/shareVideo";
import { apiRequest } from "@/lib/queryClient";

export default function VideoLibrary() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedFamily, setSelectedFamily] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("updated");

  const { data: families } = useQuery({
    queryKey: ["/api/families"],
  });

  const { data: videos, isLoading: videosLoading } = useQuery({
    queryKey: ["/api/videos"],
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
  });

  const { data: recentActivity } = useQuery({
    queryKey: ["/api/families", Array.isArray(families) ? families[0]?.id : null, "activities"],
    enabled: Array.isArray(families) && !!families[0]?.id,
  });

  const deleteVideoMutation = useMutation({
    mutationFn: async (videoId: string) => {
      const res = await apiRequest("DELETE", `/api/videos/${videoId}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Video deleted", description: "The video has been deleted." });
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
    },
    onError: (error: any) => {
      toast({ title: "Delete failed", description: error?.message || "Failed to delete video", variant: "destructive" });
    },
  });

  const handleDeleteVideo = (id: string) => {
    if (window.confirm("Are you sure you want to delete this video?")) {
      deleteVideoMutation.mutate(id);
    }
  };

  // Filter and sort videos
  const filteredVideos = Array.isArray(videos) ? videos.filter((video: any) => {
    const matchesSearch = video.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         video.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFamily = selectedFamily === "all" || video.familyId === selectedFamily;
    const matchesStatus = statusFilter === "all" || video.status === statusFilter;
    
    return matchesSearch && matchesFamily && matchesStatus;
  }).sort((a: any, b: any) => {
    switch (sortBy) {
      case "title":
        return a.title.localeCompare(b.title);
      case "created":
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case "updated":
      default:
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }
  }) : [];

  const getStatusCount = (status: string) => {
    if (status === "all") return Array.isArray(videos) ? videos.length : 0;
    return Array.isArray(videos) ? videos.filter((v: any) => v.status === status).length : 0;
  };

  const handlePlayVideo = (videoId: string) => {
    setLocation(`/videos/${videoId}`);
  };

  const handleEditVideo = (videoId: string) => {
    setLocation(`/videos/${videoId}`);
  };

  const handleShareVideo = (video: any) =>
    shareVideo({
      title: video.title,
      description: video.description,
      sharePath: `/videos/${video.id}`,
      toast,
    });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      
      <main className="pt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between mb-8">
            <div>
              <h1 className="text-3xl font-bold gradient-text mb-2">Video Library</h1>
              <p className="text-muted-foreground">Manage and organize your family videos</p>
            </div>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6 w-full lg:w-auto">
              {user?.plan === 'free' && (
                <div className="w-full lg:w-80">
                  <AdBanner placementId="video-library-header" layout="sidebar" />
                </div>
              )}
              <Link href="/create" className="lg:self-end">
                <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="button-new-video">
                  <i className="fas fa-plus mr-2"></i>
                  New Video
                </Button>
              </Link>
            </div>
          </div>

          {/* Search and Filters */}
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="flex items-center">
                <i className="fas fa-filter mr-2"></i>
                Filters & Search
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <Input
                    placeholder="Search videos..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full"
                    data-testid="input-search"
                  />
                </div>
                
                <div>
                  <Select value={selectedFamily} onValueChange={setSelectedFamily}>
                    <SelectTrigger data-testid="select-family-filter">
                      <SelectValue placeholder="All Families" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Families</SelectItem>
                      {(Array.isArray(families) ? families : []).map((family: any) => (
                        <SelectItem key={family.id} value={family.id}>
                          {family.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger data-testid="select-status-filter">
                      <SelectValue placeholder="All Statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="processing">Processing</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger data-testid="select-sort">
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="updated">Last Updated</SelectItem>
                      <SelectItem value="created">Date Created</SelectItem>
                      <SelectItem value="title">Title</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Video Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center">
                  <div className="bg-primary/20 w-12 h-12 rounded-full flex items-center justify-center">
                    <i className="fas fa-video text-primary text-xl"></i>
                  </div>
                  <div className="ml-4">
                    <p className="text-2xl font-bold" data-testid="stat-total-videos">{getStatusCount("all")}</p>
                    <p className="text-sm text-muted-foreground">Total Videos</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center">
                  <div className="bg-accent/20 w-12 h-12 rounded-full flex items-center justify-center">
                    <i className="fas fa-check text-accent text-xl"></i>
                  </div>
                  <div className="ml-4">
                    <p className="text-2xl font-bold" data-testid="stat-completed-videos">{getStatusCount("completed")}</p>
                    <p className="text-sm text-muted-foreground">Completed</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center">
                  <div className="bg-yellow-500/20 w-12 h-12 rounded-full flex items-center justify-center">
                    <i className="fas fa-spinner text-yellow-500 text-xl"></i>
                  </div>
                  <div className="ml-4">
                    <p className="text-2xl font-bold" data-testid="stat-processing-videos">{getStatusCount("processing")}</p>
                    <p className="text-sm text-muted-foreground">Processing</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center">
                  <div className="bg-secondary/20 w-12 h-12 rounded-full flex items-center justify-center">
                    <i className="fas fa-edit text-secondary-foreground text-xl"></i>
                  </div>
                  <div className="ml-4">
                    <p className="text-2xl font-bold" data-testid="stat-draft-videos">{getStatusCount("draft")}</p>
                    <p className="text-sm text-muted-foreground">Drafts</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Video Grid */}
          <Tabs defaultValue="grid" className="w-full">
            <div className="flex justify-between items-center mb-6">
              <TabsList>
                <TabsTrigger value="grid" data-testid="tab-grid">
                  <i className="fas fa-th-large mr-2"></i>
                  Grid View
                </TabsTrigger>
                <TabsTrigger value="list" data-testid="tab-list">
                  <i className="fas fa-list mr-2"></i>
                  List View
                </TabsTrigger>
              </TabsList>
              
              <div className="text-sm text-muted-foreground">
                {Array.isArray(filteredVideos) ? filteredVideos.length : 0} of {Array.isArray(videos) ? videos.length : 0} videos
              </div>
            </div>

            <TabsContent value="grid">
              {videosLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <div key={i} className="bg-card rounded-xl h-64 animate-pulse" />
                  ))}
                </div>
              ) : filteredVideos && filteredVideos.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredVideos.map((video: any) => (
                    <VideoCard key={video.id} video={video} />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12" data-testid="text-no-filtered-videos">
                  <i className="fas fa-search text-4xl text-muted-foreground mb-4"></i>
                  <h3 className="text-lg font-semibold mb-2">No videos found</h3>
                  <p className="text-muted-foreground mb-4">
                    {searchTerm || selectedFamily !== "all" || statusFilter !== "all" 
                      ? "Try adjusting your filters or search terms"
                      : "Start creating your first family video"
                    }
                  </p>
                  {!searchTerm && selectedFamily === "all" && statusFilter === "all" && (
                    <Link href="/create">
                      <Button data-testid="button-create-first-video">Create Your First Video</Button>
                    </Link>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="list">
              {videosLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="bg-card rounded-xl h-20 animate-pulse" />
                  ))}
                </div>
              ) : filteredVideos && filteredVideos.length > 0 ? (
                <div className="space-y-4">
                  {filteredVideos.map((video: any) => (
                    <Card key={video.id} className="hover:shadow-lg transition-shadow">
                      <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-4">
                            <div className="w-16 h-16 bg-secondary rounded-lg flex items-center justify-center">
                              {video.thumbnail ? (
                                <img 
                                  src={video.thumbnail} 
                                  alt={video.title}
                                  className="w-full h-full object-cover rounded-lg"
                                />
                              ) : (
                                <i className="fas fa-video text-2xl text-muted-foreground"></i>
                              )}
                            </div>
                            <div className="flex-1">
                              <h3 className="text-lg font-semibold mb-1">{video.title}</h3>
                              <p className="text-sm text-muted-foreground mb-2">
                                {video.description?.substring(0, 100)}...
                              </p>
                              <div className="flex items-center space-x-4 text-xs text-muted-foreground">
                                <span>
                                  <i className="fas fa-clock mr-1"></i>
                                  {video.duration ? `${Math.floor(video.duration / 60)}:${(video.duration % 60).toString().padStart(2, '0')}` : '--:--'}
                                </span>
                                <span>
                                  <i className="fas fa-calendar mr-1"></i>
                                  {new Date(video.updatedAt).toLocaleDateString()}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center space-x-4">
                            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                              video.status === 'completed' 
                                ? 'bg-primary/20 text-primary' 
                                : video.status === 'processing'
                                ? 'bg-accent/20 text-accent'
                                : video.status === 'draft'
                                ? 'bg-secondary/20 text-secondary-foreground'
                                : 'bg-destructive/20 text-destructive'
                            }`}>
                              {video.status === 'completed' && <i className="fas fa-check mr-1"></i>}
                              {video.status === 'processing' && <i className="fas fa-spinner fa-spin mr-1"></i>}
                              {video.status === 'draft' && <i className="fas fa-pencil mr-1"></i>}
                              {video.status === 'error' && <i className="fas fa-exclamation mr-1"></i>}
                              {video.status}
                            </span>
                            <div className="flex space-x-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handlePlayVideo(video.id)}
                                data-testid="button-play"
                              >
                                <i className="fas fa-play"></i>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleEditVideo(video.id)}
                                data-testid="button-edit"
                              >
                                <i className="fas fa-edit"></i>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleShareVideo(video)}
                                data-testid="button-share"
                              >
                                <i className="fas fa-share"></i>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteVideo(video.id)}
                                disabled={deleteVideoMutation.isPending}
                                data-testid="button-delete"
                                className="text-destructive hover:text-destructive"
                              >
                                <i className="fas fa-trash"></i>
                              </Button>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12" data-testid="text-no-list-videos">
                  <i className="fas fa-search text-4xl text-muted-foreground mb-4"></i>
                  <h3 className="text-lg font-semibold mb-2">No videos found</h3>
                  <p className="text-muted-foreground">Try adjusting your filters or search terms</p>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
