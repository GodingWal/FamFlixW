import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { apiRequest } from "@/lib/queryClient";

const videoSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  familyId: z.string().optional(),
  sourceVideoId: z.string().optional(), // For user projects based on provided videos
});

type VideoFormData = z.infer<typeof videoSchema>;

export default function VideoCreation() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("details");
  const [, navigate] = useLocation();
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [selectedProvidedVideo, setSelectedProvidedVideo] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [generatedScript, setGeneratedScript] = useState("");
  
  const isAdmin = user?.role === 'admin';

  const form = useForm<VideoFormData>({
    resolver: zodResolver(videoSchema),
    defaultValues: {
      title: "",
      description: "",
      familyId: "",
    },
  });

  const { data: families } = useQuery({
    queryKey: ["/api/families"],
  });

  // Get template videos for users to select from
  const { data: providedVideos } = useQuery({
    queryKey: ["/api/template-videos"],
    enabled: !isAdmin, // Only fetch for regular users
  });

  const { data: suggestions, isLoading: suggestionsLoading } = useQuery({
    queryKey: ["/api/videos/suggestions", form.watch("familyId")],
    enabled: !!form.watch("familyId"),
  });

  const createVideoMutation = useMutation({
    mutationFn: async (data: VideoFormData & { video?: File }) => {
      if (isAdmin) {
        // Admin video upload with file
        const formData = new FormData();
        Object.entries(data).forEach(([key, value]) => {
          if (key !== "video" && value) {
            formData.append(key, value);
          }
        });
        if (data.video) {
          formData.append("video", data.video);
        }

        const response = await fetch("/api/admin/videos", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${localStorage.getItem("token")}`,
          },
          body: formData,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to create video");
        }

        return response.json();
      } else {
        // User project creation (no file upload) against template videos
        const response = await apiRequest("POST", "/api/video-projects", {
          templateVideoId: selectedProvidedVideo ? Number(selectedProvidedVideo) : undefined,
          status: "pending",
          metadata: data.description ? { description: data.description } : undefined,
        });
        return response.json();
      }
    },
    onSuccess: (result: any) => {
      // If user flow, navigate to project setup
      if (!isAdmin && result?.id) {
        navigate(`/projects/${result.id}/setup`);
      }
      toast({
        title: "Video created!",
        description: "Your video has been created successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/video-projects"] });
      form.reset();
      setVideoFile(null);
    },
    onError: (error: any) => {
      toast({
        title: "Creation failed",
        description: error.message || "Failed to create video",
        variant: "destructive",
      });
    },
  });

  const generateScriptMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const response = await apiRequest("POST", "/api/ai/video-script", {
        prompt,
        familyId: form.watch("familyId"),
      });
      return response.json();
    },
    onSuccess: (data) => {
      setGeneratedScript(data.script);
      form.setValue("description", data.script);
      toast({
        title: "Script generated!",
        description: "AI has generated a script for your video.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Generation failed",
        description: error.message || "Failed to generate script",
        variant: "destructive",
      });
    },
  });

  const enhanceDescriptionMutation = useMutation({
    mutationFn: async (description: string) => {
      const response = await apiRequest("POST", "/api/ai/enhance-description", {
        description,
      });
      return response.json();
    },
    onSuccess: (data) => {
      form.setValue("description", data.enhanced);
      toast({
        title: "Description enhanced!",
        description: "AI has improved your video description.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Enhancement failed",
        description: error.message || "Failed to enhance description",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: VideoFormData) => {
    if (!isAdmin && !selectedProvidedVideo) {
      toast({
        title: "Video selection required",
        description: "Please select a video to create your project",
        variant: "destructive",
      });
      return;
    }
    createVideoMutation.mutate({ ...data, video: videoFile || undefined });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
    }
  };

  const generateScript = () => {
    if (!aiPrompt.trim()) {
      toast({
        title: "Prompt required",
        description: "Please enter a prompt for AI script generation",
        variant: "destructive",
      });
      return;
    }
    generateScriptMutation.mutate(aiPrompt);
  };

  const enhanceDescription = () => {
    const description = form.watch("description");
    if (!description?.trim()) {
      toast({
        title: "Description required",
        description: "Please enter a description to enhance",
        variant: "destructive",
      });
      return;
    }
    enhanceDescriptionMutation.mutate(description);
  };

  const applySuggestion = (suggestion: string) => {
    form.setValue("title", suggestion);
    setAiPrompt(suggestion);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      
      <main className="pt-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold gradient-text mb-2">Create New Video</h1>
            <p className="text-muted-foreground">Bring your family memories to life with AI-powered tools</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* AI Suggestions Sidebar */}
            <div className="lg:col-span-1">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <i className="fas fa-lightbulb mr-2 text-accent"></i>
                    AI Suggestions
                  </CardTitle>
                  <CardDescription>Creative ideas for your family video</CardDescription>
                </CardHeader>
                <CardContent>
                  {suggestionsLoading ? (
                    <div className="space-y-2">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="h-4 bg-muted rounded animate-pulse" />
                      ))}
                    </div>
                  ) : Array.isArray(suggestions) && suggestions.length > 0 ? (
                    <div className="space-y-2">
                      {(suggestions || []).map((suggestion: string, index: number) => (
                        <button
                          key={index}
                          onClick={() => applySuggestion(suggestion)}
                          className="w-full text-left p-3 rounded-lg bg-secondary/50 hover:bg-secondary/70 transition-colors text-sm"
                          data-testid={`button-suggestion-${index}`}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="text-no-suggestions">
                      Select a family to see personalized suggestions
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Main Creation Form */}
            <div className="lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Video Details</CardTitle>
                  <CardDescription>Set up your video project</CardDescription>
                </CardHeader>
                <CardContent>
                  <Tabs value={activeTab} onValueChange={setActiveTab}>
                    <TabsList className="grid w-full grid-cols-3">
                      <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
                      <TabsTrigger value="ai" data-testid="tab-ai">AI Tools</TabsTrigger>
                      <TabsTrigger value={isAdmin ? "upload" : "select"} data-testid={isAdmin ? "tab-upload" : "tab-select"}>
                        {isAdmin ? "Upload" : "Select Video"}
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="details" className="space-y-4">
                      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <div>
                          <Label htmlFor="title">Video Title</Label>
                          <Input
                            id="title"
                            {...form.register("title")}
                            placeholder="My Amazing Family Adventure"
                            data-testid="input-title"
                          />
                          {form.formState.errors.title && (
                            <p className="text-sm text-destructive mt-1">
                              {form.formState.errors.title.message}
                            </p>
                          )}
                        </div>

                        <div>
                          <Label htmlFor="familyId">Family</Label>
                          <Select value={form.watch("familyId")} onValueChange={(value) => form.setValue("familyId", value)}>
                            <SelectTrigger data-testid="select-family">
                              <SelectValue placeholder="Select a family" />
                            </SelectTrigger>
                            <SelectContent>
                              {(Array.isArray(families) ? families : []).map((family: any) => (
                                <SelectItem key={family.id} value={family.id}>
                                  {family.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div>
                          <div className="flex justify-between items-center">
                            <Label htmlFor="description">Description / Script</Label>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={enhanceDescription}
                              disabled={enhanceDescriptionMutation.isPending}
                              data-testid="button-enhance-description"
                            >
                              {enhanceDescriptionMutation.isPending ? (
                                <i className="fas fa-spinner fa-spin mr-1"></i>
                              ) : (
                                <i className="fas fa-magic mr-1"></i>
                              )}
                              Enhance with AI
                            </Button>
                          </div>
                          <Textarea
                            id="description"
                            {...form.register("description")}
                            placeholder="Describe your video or paste an AI-generated script..."
                            className="min-h-[120px]"
                            data-testid="textarea-description"
                          />
                        </div>

                        <Button
                          type="submit"
                          className="w-full"
                          disabled={createVideoMutation.isPending}
                          data-testid="button-create-video"
                        >
                          {createVideoMutation.isPending ? (
                            <>
                              <i className="fas fa-spinner fa-spin mr-2"></i>
                              Creating Video...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-video mr-2"></i>
                              Create Video
                            </>
                          )}
                        </Button>
                      </form>
                    </TabsContent>

                    <TabsContent value="ai" className="space-y-4">
                      <div>
                        <Label htmlFor="aiPrompt">AI Script Generator</Label>
                        <div className="flex gap-2">
                          <Textarea
                            id="aiPrompt"
                            value={aiPrompt}
                            onChange={(e) => setAiPrompt(e.target.value)}
                            placeholder="Describe the video you want to create... e.g., 'A heartwarming story about our summer vacation'"
                            className="min-h-[100px]"
                            data-testid="textarea-ai-prompt"
                          />
                        </div>
                        <Button
                          onClick={generateScript}
                          disabled={generateScriptMutation.isPending}
                          className="w-full mt-2"
                          data-testid="button-generate-script"
                        >
                          {generateScriptMutation.isPending ? (
                            <>
                              <i className="fas fa-spinner fa-spin mr-2"></i>
                              Generating Script...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-robot mr-2"></i>
                              Generate Script with AI
                            </>
                          )}
                        </Button>
                      </div>

                      {generatedScript && (
                        <div className="bg-secondary/20 rounded-lg p-4">
                          <h4 className="font-semibold mb-2">Generated Script:</h4>
                          <p className="text-sm whitespace-pre-wrap" data-testid="text-generated-script">{generatedScript}</p>
                        </div>
                      )}
                    </TabsContent>

                    {isAdmin ? (
                      <TabsContent value="upload" className="space-y-4">
                        <div>
                          <Label htmlFor="videoFile">Upload Video File (Required for Admin)</Label>
                          <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                            <input
                              type="file"
                              id="videoFile"
                              accept="video/*"
                              onChange={handleFileChange}
                              className="hidden"
                              data-testid="input-video-file"
                            />
                            <label htmlFor="videoFile" className="cursor-pointer">
                              <i className="fas fa-cloud-upload text-4xl text-muted-foreground mb-4 block"></i>
                              <p className="text-muted-foreground mb-2">
                                {videoFile ? videoFile.name : "Click to upload video file"}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                Supports MP4, MOV, AVI (Max 50MB)
                              </p>
                            </label>
                          </div>
                        </div>

                        {videoFile && (
                          <div className="bg-secondary/20 rounded-lg p-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-medium">{videoFile.name}</p>
                                <p className="text-sm text-muted-foreground">
                                  {(videoFile.size / (1024 * 1024)).toFixed(2)} MB
                                </p>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setVideoFile(null)}
                                data-testid="button-remove-file"
                              >
                                <i className="fas fa-times"></i>
                              </Button>
                            </div>
                          </div>
                        )}
                      </TabsContent>
                    ) : (
                      <TabsContent value="select" className="space-y-4">
                        <div>
                          <Label>Select Video to Create Project</Label>
                          <div className="grid gap-4 mt-2">
                            {Array.isArray(providedVideos) && providedVideos.length > 0 ? (
                              providedVideos.map((video: any) => (
                                <Card 
                                  key={video.id} 
                                  className={`cursor-pointer transition-colors ${
                                    selectedProvidedVideo === video.id 
                                      ? 'ring-2 ring-primary bg-primary/5' 
                                      : 'hover:bg-secondary/20'
                                  }`}
                                  onClick={() => setSelectedProvidedVideo(video.id)}
                                  data-testid={`card-video-${video.id}`}
                                >
                                  <CardContent className="p-4">
                                    <div className="flex items-center space-x-4">
                                      <div className="w-16 h-16 bg-secondary rounded-lg flex items-center justify-center">
                                        <i className="fas fa-video text-2xl text-muted-foreground"></i>
                                      </div>
                                      <div className="flex-1">
                                        <h4 className="font-semibold">{video.title}</h4>
                                        <p className="text-sm text-muted-foreground">{video.description}</p>
                                        <p className="text-xs text-muted-foreground mt-1">
                                          Duration: {video.duration ? `${Math.floor(video.duration / 60)}:${(video.duration % 60).toString().padStart(2, '0')}` : 'Unknown'}
                                        </p>
                                      </div>
                                      {selectedProvidedVideo === video.id && (
                                        <div className="text-primary">
                                          <i className="fas fa-check-circle text-xl"></i>
                                        </div>
                                      )}
                                    </div>
                                  </CardContent>
                                </Card>
                              ))
                            ) : (
                              <div className="text-center py-8 text-muted-foreground">
                                <i className="fas fa-video text-4xl mb-4 block"></i>
                                <p>No videos available for selection</p>
                                <p className="text-sm">Contact an administrator to add videos</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </TabsContent>
                    )}
                  </Tabs>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
