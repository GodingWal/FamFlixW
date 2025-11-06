import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { shareVideo } from "@/lib/shareVideo";
import { useLocation } from "wouter";

interface VideoCardProps {
  video: {
    id: string;
    title: string;
    description?: string;
    thumbnail?: string;
    duration?: number;
    status: string;
    createdAt: string;
    updatedAt: string;
    videoUrl?: string;
  };
}

export function VideoCard({ video }: VideoCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isHovered, setIsHovered] = useState(false);
  const [, setLocation] = useLocation();
  const videoRoute = `/videos/${video.id}`;

  const deleteVideoMutation = useMutation({
    mutationFn: async (videoId: string) => {
      const response = await apiRequest("DELETE", `/api/videos/${videoId}`);
      return response.json();
    },
    onMutate: async (videoId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/videos"] });
      const previous = queryClient.getQueryData<any[]>(["/api/videos"]);
      if (Array.isArray(previous)) {
        queryClient.setQueryData(["/api/videos"], previous.filter(v => v.id !== videoId));
      }
      return { previous };
    },
    onError: (error: any, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/videos"], context.previous);
      }
      toast({
        title: "Delete failed",
        description: error?.message || "Failed to delete video",
        variant: "destructive",
      });
    },
    onSuccess: () => {
      toast({
        title: "Video deleted",
        description: "The video has been successfully deleted.",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
    }
  });

  const formatDuration = (seconds?: number) => {
    if (!seconds) return "--:--";
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-primary/20 text-primary';
      case 'processing':
        return 'bg-accent/20 text-accent';
      case 'draft':
        return 'bg-secondary/20 text-secondary-foreground';
      case 'error':
        return 'bg-destructive/20 text-destructive';
      default:
        return 'bg-muted/20 text-muted-foreground';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return 'fas fa-check';
      case 'processing':
        return 'fas fa-spinner fa-spin';
      case 'draft':
        return 'fas fa-pencil';
      case 'error':
        return 'fas fa-exclamation';
      default:
        return 'fas fa-clock';
    }
  };

  const handleDelete = () => {
    if (window.confirm("Are you sure you want to delete this video?")) {
      deleteVideoMutation.mutate(video.id);
    }
  };

  const handlePlay = () => {
    setLocation(videoRoute);
  };

  const handleEdit = () => {
    setLocation(videoRoute);
  };

  const handleShare = () =>
    shareVideo({
      title: video.title,
      description: video.description,
      sharePath: videoRoute,
      toast,
    });

  return (
    <Card 
      className="video-card bg-card rounded-xl overflow-hidden shadow-lg hover:shadow-xl transition-all duration-300"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      data-testid={`video-card-${video.id}`}
    >
      {/* Thumbnail */}
      <div className="relative w-full h-48 bg-secondary/50 overflow-hidden">
        {video.thumbnail ? (
          <img 
            src={video.thumbnail} 
            alt={video.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <i className="fas fa-video text-4xl text-muted-foreground"></i>
          </div>
        )}
        
        {/* Play overlay */}
        {isHovered && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <Button
              onClick={handlePlay}
              size="lg"
              className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-full w-16 h-16"
              data-testid="button-play-video"
            >
              <i className="fas fa-play text-xl"></i>
            </Button>
          </div>
        )}

        {/* Duration badge */}
        {video.duration && (
          <div className="absolute bottom-2 right-2 bg-black/70 text-white px-2 py-1 rounded text-xs">
            {formatDuration(video.duration)}
          </div>
        )}
      </div>

      {/* Content */}
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold truncate flex-1" data-testid="video-title">
            {video.title}
          </h3>
          <span className={`px-2 py-1 rounded-full text-xs font-medium ml-2 ${getStatusColor(video.status)}`}>
            <i className={`${getStatusIcon(video.status)} mr-1`}></i>
            {video.status}
          </span>
        </div>
        
        <p className="text-muted-foreground text-sm mb-4 line-clamp-2" data-testid="video-description">
          {video.description || "No description available"}
        </p>
        
        <div className="flex items-center justify-between">
          <div className="flex items-center text-sm text-muted-foreground">
            <i className="fas fa-calendar mr-1"></i>
            <span data-testid="video-date">
              {new Date(video.updatedAt).toLocaleDateString()}
            </span>
          </div>
          
          <div className="flex space-x-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePlay}
              className="text-muted-foreground hover:text-primary transition-colors"
              data-testid="button-play"
            >
              <i className="fas fa-play"></i>
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              onClick={handleEdit}
              className="text-muted-foreground hover:text-primary transition-colors"
              data-testid="button-edit"
            >
              <i className="fas fa-edit"></i>
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              onClick={handleShare}
              className="text-muted-foreground hover:text-primary transition-colors"
              data-testid="button-share"
            >
              <i className="fas fa-share"></i>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={deleteVideoMutation.isPending}
              className="text-destructive hover:text-destructive"
              data-testid="button-delete"
            >
              <i className="fas fa-trash"></i>
            </Button>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-primary transition-colors"
                  data-testid="button-video-menu"
                >
                  <i className="fas fa-ellipsis-v"></i>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleEdit} data-testid="menu-edit-video">
                  <i className="fas fa-edit mr-2"></i>
                  Edit Video
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleShare} data-testid="menu-share-video">
                  <i className="fas fa-share mr-2"></i>
                  Share Video
                </DropdownMenuItem>
                <DropdownMenuItem 
                  onClick={handleDelete}
                  className="text-destructive focus:text-destructive"
                  disabled={deleteVideoMutation.isPending}
                  data-testid="menu-delete-video"
                >
                  <i className="fas fa-trash mr-2"></i>
                  {deleteVideoMutation.isPending ? "Deleting..." : "Delete Video"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
