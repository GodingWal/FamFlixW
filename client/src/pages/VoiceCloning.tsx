import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { VoiceProfileCard } from "@/components/VoiceProfileCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import type { VoiceGeneration } from "@shared/schema";

// Feature flags
const FACE_FEATURE_ENABLED = false;

interface StorySummary {
  slug: string;
  title: string;
  summary?: string | null;
  category?: string | null;
}

interface StoryListResponse {
  stories: StorySummary[];
}

interface StoryDetailResponse extends StorySummary {
  content?: string | null;
}

const voiceProfileSchema = z.object({
  name: z.string().min(1, "Name is required"),
  familyId: z.string().optional(),
});

const faceProfileSchema = z.object({
  name: z.string().min(1, "Name is required"),
  familyId: z.string().optional(),
});

// Voice recording sentences for comprehensive voice capture
const VOICE_SENTENCES = [
  "Hello, my name is [Your Name] and I'm excited to create my voice clone.",
  "The quick brown fox jumps over the lazy dog near the riverbank.",
  "I love spending time with my family during holidays and special occasions.",
  "Can you believe how amazing technology has become in recent years?",
  "Sometimes I wonder what the future holds for artificial intelligence.",
  "My favorite memories include laughing with friends and sharing stories.",
  "Please remember to speak clearly and naturally for the best results.",
  "Thank you for taking the time to help me create this voice profile."
];

// Face recording directions for 360-degree capture
const FACE_DIRECTIONS = [
  { instruction: "Look straight ahead", angle: "center", duration: 3 },
  { instruction: "Turn your head slowly to the right", angle: "right", duration: 4 },
  { instruction: "Look straight ahead again", angle: "center", duration: 2 },
  { instruction: "Turn your head slowly to the left", angle: "left", duration: 4 },
  { instruction: "Look straight ahead", angle: "center", duration: 2 },
  { instruction: "Look up slightly", angle: "up", duration: 3 },
  { instruction: "Look down slightly", angle: "down", duration: 3 },
  { instruction: "Final look straight ahead with a slight smile", angle: "center", duration: 3 }
];

const voiceGenerationSchema = z.object({
  text: z.string().min(1, "Text is required"),
  voiceProfileId: z.string().min(1, "Voice profile is required"),
});

type VoiceProfileFormData = z.infer<typeof voiceProfileSchema>;
type VoiceGenerationFormData = z.infer<typeof voiceGenerationSchema>;
type FaceProfileFormData = z.infer<typeof faceProfileSchema>;

export default function VoiceCloning() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState("voice");
  const [isRecording, setIsRecording] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  
  // Voice recording flow states
  const [voiceStep, setVoiceStep] = useState(0);
  const [recordedAudios, setRecordedAudios] = useState<{[key: number]: Blob}>({});
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  
  // Face recording flow states
  const [faceStep, setFaceStep] = useState(0);
  const [isRecordingFace, setIsRecordingFace] = useState(false);
  const [recordedFaceVideo, setRecordedFaceVideo] = useState<Blob | null>(null);
  const [faceRecorder, setFaceRecorder] = useState<MediaRecorder | null>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isCreatingFamily, setIsCreatingFamily] = useState(false);
  const [newFamilyName, setNewFamilyName] = useState("");
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [selectedStorySlug, setSelectedStorySlug] = useState<string>("");
  const lastAppliedStorySlugRef = useRef<string | null>(null);

  const profileForm = useForm<VoiceProfileFormData>({
    resolver: zodResolver(voiceProfileSchema),
    defaultValues: {
      name: "",
      familyId: "",
    },
  });

  const generationForm = useForm<VoiceGenerationFormData>({
    resolver: zodResolver(voiceGenerationSchema),
    defaultValues: {
      text: "",
      voiceProfileId: "",
    },
  });

  const faceForm = useForm<FaceProfileFormData>({
    resolver: zodResolver(faceProfileSchema),
    defaultValues: {
      name: "",
      familyId: "",
    },
  });

  const { data: families } = useQuery({
    queryKey: ["/api/families"],
  });

  const createFamilyMutation = useMutation({
    mutationFn: async (familyName: string) => {
      const response = await fetch("/api/families", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({ name: familyName, description: `${familyName} family` }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create family");
      }

      return response.json();
    },
    onSuccess: (newFamily) => {
      toast({
        title: "Family created!",
        description: `${newFamily.name} family has been created successfully.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/families"] });
      setIsCreatingFamily(false);
      setNewFamilyName("");
      // Auto-select the newly created family
      profileForm.setValue("familyId", newFamily.id);
      faceForm.setValue("familyId", newFamily.id);
    },
    onError: (error: any) => {
      toast({
        title: "Creation failed",
        description: error.message || "Failed to create family",
        variant: "destructive",
      });
    },
  });

  const { data: voiceProfiles, isLoading: profilesLoading } = useQuery({
    queryKey: ["/api/voice-profiles"],
    refetchInterval: 5000, // Refresh every 5 seconds to show training progress
  });

  const { data: voiceGenerations } = useQuery<VoiceGeneration[]>({
    queryKey: [`/api/voice-profiles/${selectedProfile}/generations`],
    enabled: !!selectedProfile,
  });

  const {
    data: storyCatalog,
    isLoading: storyCatalogLoading,
    error: storyCatalogError,
    refetch: refetchStoryCatalog,
  } = useQuery<StoryListResponse>({
    queryKey: ["voice-cloning-story-catalog"],
    queryFn: async () => {
      const response = await fetch("/api/stories?limit=50");
      if (!response.ok) {
        throw new Error("Failed to load stories");
      }
      return response.json();
    },
  });

  const {
    data: selectedStory,
    isFetching: selectedStoryLoading,
    error: selectedStoryError,
  } = useQuery<StoryDetailResponse>({
    queryKey: ["voice-cloning-story-detail", selectedStorySlug],
    queryFn: async () => {
      const response = await fetch(`/api/stories/${selectedStorySlug}`);
      if (!response.ok) {
        throw new Error("Failed to load story content");
      }
      return response.json();
    },
    enabled: Boolean(selectedStorySlug),
    staleTime: 1000 * 60 * 5,
  });

  useEffect(() => {
    if (storyCatalogError instanceof Error) {
      toast({
        title: "Story library unavailable",
        description: storyCatalogError.message || "We couldn't load curated stories right now.",
        variant: "destructive",
      });
    }
  }, [storyCatalogError, toast]);

  useEffect(() => {
    if (selectedStoryError instanceof Error) {
      toast({
        title: "Couldn't load story",
        description: selectedStoryError.message || "Try picking a different story or writing your own.",
        variant: "destructive",
      });
      setSelectedStorySlug("");
      lastAppliedStorySlugRef.current = null;
    }
  }, [selectedStoryError, toast]);

  useEffect(() => {
    if (
      selectedStorySlug &&
      selectedStory?.content &&
      lastAppliedStorySlugRef.current !== selectedStorySlug
    ) {
      generationForm.setValue("text", selectedStory.content);
      generationForm.clearErrors("text");
      lastAppliedStorySlugRef.current = selectedStorySlug;
      toast({
        title: "Story loaded",
        description: `We filled the text area with “${selectedStory.title ?? "selected story"}”. Feel free to edit it before generating speech.`,
      });
    }
  }, [selectedStorySlug, selectedStory, generationForm, toast]);

  const createProfileMutation = useMutation({
    mutationFn: async (data: VoiceProfileFormData & { audio: File }) => {
      // Client-side validation before sending
      if (!data.name || data.name.trim().length === 0) {
        throw new Error("Valid name is required");
      }
      
      if (data.name.length > 50) {
        throw new Error("Name must be 50 characters or less");
      }
      
      if (!data.audio) {
        throw new Error("Audio file is required");
      }
      
      // Validate audio file
      const allowedTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg'];
      if (!allowedTypes.includes(data.audio.type)) {
        throw new Error("Invalid audio format. Please use WAV, MP3, WebM, or OGG");
      }
      
      if (data.audio.size > 10 * 1024 * 1024) {
        throw new Error("Audio file too large. Maximum size is 10MB");
      }
      
      if (data.audio.size < 1024) {
        throw new Error("Audio file too small. Please provide a valid recording");
      }
      
      const formData = new FormData();
      formData.append("name", data.name.trim());
      if (data.familyId) {
        formData.append("familyId", data.familyId);
      }
      formData.append("audio", data.audio);

      const response = await fetch("/api/voice-profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create voice profile");
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Voice Clone Training Started",
        description: "Your voice clone is now training. This will take about 2 minutes to complete.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/voice-profiles"] });
      profileForm.reset();
      setAudioFile(null);
      setRecordedAudios({});
      setVoiceStep(0);
    },
    onError: (error: any) => {
      console.error('Voice profile creation error:', error);
      toast({
        title: "Voice Profile Creation Failed",
        description: error.message || "Failed to create voice profile. Please try again.",
        variant: "destructive",
      });
    },
  });

  const generateSpeechMutation = useMutation({
    mutationFn: async (data: VoiceGenerationFormData) => {
      const response = await fetch(`/api/voice-profiles/${data.voiceProfileId}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({ text: data.text }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to generate speech");
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Speech generated!",
        description: "AI has generated speech using the selected voice.",
      });
      queryClient.invalidateQueries({ 
        queryKey: [`/api/voice-profiles/${selectedProfile}/generations`] 
      });
      generationForm.reset();
    },
    onError: (error: any) => {
      toast({
        title: "Generation failed",
        description: error.message || "Failed to generate speech",
        variant: "destructive",
      });
    },
  });

  const generateStoryMutation = useMutation({
    mutationFn: async (voiceProfileId: string) => {
      console.log('generateStoryMutation starting with voiceProfileId:', voiceProfileId);
      const userFamilies = families as any[];
      const familyId = userFamilies?.[0]?.id; // Use first family for context
      console.log('Using familyId:', familyId);
      
      const response = await fetch(`/api/ai/auto-story/${voiceProfileId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: JSON.stringify({ familyId }),
      });

      console.log('Story API response status:', response.status);
      if (!response.ok) {
        const error = await response.json();
        console.error('Story API error:', error);
        throw new Error(error.error || "Failed to generate story");
      }

      const data = await response.json();
      console.log('Story API success data:', data);
      return data;
    },
    onSuccess: (data) => {
      console.log('Story generation successful:', data);
      toast({
        title: "Story generated and narrated!",
        description: "AI has created a magical short story and converted it to speech.",
      });
      // Update the text field with the generated story
      generationForm.setValue("text", data.story);
      queryClient.invalidateQueries({ 
        queryKey: [`/api/voice-profiles/${selectedProfile}/generations`] 
      });
    },
    onError: (error: any) => {
      console.error('Story generation error:', error);
      toast({
        title: "Story generation failed",
        description: error.message || "Failed to generate story",
        variant: "destructive",
      });
    },
  });

  const createFaceProfileMutation = useMutation({
    mutationFn: async (data: FaceProfileFormData & { image: File }) => {
      const formData = new FormData();
      formData.append("name", data.name);
      if (data.familyId) {
        formData.append("familyId", data.familyId);
      }
      formData.append("image", data.image);

      const response = await fetch("/api/face-profiles", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create face profile");
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Face profile created!",
        description: "Your face has been successfully cloned.",
      });
      faceForm.reset();
      setImageFile(null);
    },
    onError: (error: any) => {
      toast({
        title: "Creation failed",
        description: error.message || "Failed to create face profile. This feature is coming soon!",
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type.startsWith("audio/")) {
        setAudioFile(file);
      } else {
        toast({
          title: "Invalid file type",
          description: "Please upload an audio file",
          variant: "destructive",
        });
      }
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type.startsWith("image/")) {
        setImageFile(file);
      } else {
        toast({
          title: "Invalid file type",
          description: "Please upload an image file",
          variant: "destructive",
        });
      }
    }
  };

  const startVoiceRecording = async (stepIndex: number) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setAudioStream(stream);
      setIsRecording(true);
      
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      
      recorder.onstop = () => {
        const audioBlob = new Blob(chunks, { type: 'audio/wav' });
        setRecordedAudios(prev => ({ ...prev, [stepIndex]: audioBlob }));
        setIsRecording(false);
        stream.getTracks().forEach(track => track.stop());
        setAudioStream(null);
      };
      
      setMediaRecorder(recorder);
      recorder.start();
    } catch (error) {
      toast({
        title: "Recording failed",
        description: "Could not access microphone",
        variant: "destructive",
      });
    }
  };

  const stopVoiceRecording = () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  };

  const startFaceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 640 }, 
          height: { ideal: 480 },
          facingMode: 'user'
        } 
      });
      
      setVideoStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      setIsRecordingFace(true);
      setFaceStep(0);
      
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      
      recorder.onstop = () => {
        const videoBlob = new Blob(chunks, { type: 'video/webm' });
        setRecordedFaceVideo(videoBlob);
        setIsRecordingFace(false);
        stream.getTracks().forEach(track => track.stop());
        setVideoStream(null);
      };
      
      setFaceRecorder(recorder);
      recorder.start();
      
      // Auto-advance through face directions
      let currentStep = 0;
      const interval = setInterval(() => {
        currentStep++;
        if (currentStep < FACE_DIRECTIONS.length) {
          setFaceStep(currentStep);
        } else {
          clearInterval(interval);
          recorder.stop();
        }
      }, FACE_DIRECTIONS[0].duration * 1000);
      
    } catch (error) {
      toast({
        title: "Camera access failed",
        description: "Could not access camera for face recording",
        variant: "destructive",
      });
    }
  };

  const stopFaceRecording = () => {
    if (faceRecorder && faceRecorder.state === 'recording') {
      faceRecorder.stop();
    }
  };

  const onCreateProfile = async (data: VoiceProfileFormData) => {
    // Check if recording is complete or audio file is uploaded
    const hasRecordedAudio = Object.keys(recordedAudios).length === VOICE_SENTENCES.length;
    if (!audioFile && !hasRecordedAudio) {
      toast({
        title: "Audio file required",
        description: "Please upload or record an audio sample",
        variant: "destructive",
      });
      return;
    }
    
    try {
      // If recording is complete, combine all audio chunks into a single file
      const audioToSend = audioFile || await createCombinedAudioFile();
      
      // Validate audio quality for cloning
      const validationResult = await validateAudioForCloning(audioToSend);
      if (!validationResult.isValid) {
        toast({
          title: "Audio quality issue",
          description: validationResult.message,
          variant: "destructive",
        });
        return;
      }
      
      if (validationResult.warnings.length > 0) {
        console.warn('Audio quality warnings:', validationResult.warnings);
        toast({
          title: "Audio quality notice",
          description: validationResult.warnings[0],
        });
      }
      
      createProfileMutation.mutate({ ...data, audio: audioToSend });
    } catch (error) {
      console.error('Error preparing audio:', error);
      toast({
        title: "Audio processing error",
        description: "Failed to process audio recordings. Please try again.",
        variant: "destructive",
      });
    }
  };

  const validateAudioForCloning = async (audioFile: File): Promise<{
    isValid: boolean;
    message: string;
    warnings: string[];
  }> => {
    const warnings: string[] = [];
    
    try {
      // Check file size (should be reasonable for voice cloning)
      const fileSizeMB = audioFile.size / (1024 * 1024);
      if (fileSizeMB < 0.1) {
        return {
          isValid: false,
          message: "Audio file is too small. Please provide at least 10 seconds of clear speech.",
          warnings
        };
      }
      
      if (fileSizeMB > 50) {
        warnings.push("Large audio file detected. Consider shorter recordings for better processing.");
      }

      // Analyze audio content
      const arrayBuffer = await audioFile.arrayBuffer();
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Check duration (longer samples generally produce better clones; shorter is acceptable)
      const duration = audioBuffer.duration;
      if (duration < 5) {
        warnings.push("Short audio detected. Longer recordings (30+ seconds) typically produce better voice clones.");
      }
      
      if (duration > 1800) { // 30 minutes
        warnings.push("Very long audio detected. Consider breaking into shorter segments for better processing.");
      }

      // Check sample rate
      if (audioBuffer.sampleRate < 22050) {
        warnings.push("Low sample rate detected. Higher quality recordings produce better voice clones.");
      }

      // Check for silence/very quiet audio
      const channelData = audioBuffer.getChannelData(0);
      const rms = Math.sqrt(channelData.reduce((sum, sample) => sum + sample * sample, 0) / channelData.length);
      
      if (rms < 0.01) {
        return {
          isValid: false,
          message: "Audio appears to be too quiet or mostly silent. Please record with clear, audible speech.",
          warnings
        };
      }
      
      if (rms < 0.05) {
        warnings.push("Audio level is quite low. Consider recording closer to the microphone or increasing volume.");
      }

      return {
        isValid: true,
        message: "Audio quality looks good for voice cloning!",
        warnings
      };
      
    } catch (error) {
      console.error('Audio validation error:', error);
      return {
        isValid: true, // Don't block if validation fails
        message: "Could not validate audio quality, but proceeding anyway.",
        warnings: ["Audio validation failed - please ensure your recording is clear and audible."]
      };
    }
  };

  const createCombinedAudioFile = async (): Promise<File> => {
    const audioBlobs = Object.values(recordedAudios);
    if (audioBlobs.length === 0) {
      throw new Error('No recorded audio available');
    }

    // If only one recording, return it directly
    if (audioBlobs.length === 1) {
      return new File([audioBlobs[0]], 'recorded-voice-sample.wav', { type: 'audio/wav' });
    }

    // Combine multiple audio blobs
    try {
      const combinedBlob = await combineAudioBlobs(audioBlobs);
      return new File([combinedBlob], 'combined-voice-sample.wav', { type: 'audio/wav' });
    } catch (error) {
      console.error('Error combining audio:', error);
      // Fallback to the longest recording
      const longestBlob = audioBlobs.reduce((longest, current) => 
        current.size > longest.size ? current : longest
      );
      return new File([longestBlob], 'recorded-voice-sample.wav', { type: 'audio/wav' });
    }
  };

  const combineAudioBlobs = async (audioBlobs: Blob[]): Promise<Blob> => {
    // Create audio context for combining audio
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuffers: AudioBuffer[] = [];

    // Convert all blobs to audio buffers
    for (const blob of audioBlobs) {
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        audioBuffers.push(audioBuffer);
      } catch (error) {
        console.warn('Failed to decode audio blob, skipping:', error);
      }
    }

    if (audioBuffers.length === 0) {
      throw new Error('No valid audio data found');
    }

    // Calculate total length and create combined buffer
    const totalLength = audioBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const combinedBuffer = audioContext.createBuffer(
      audioBuffers[0].numberOfChannels,
      totalLength,
      audioBuffers[0].sampleRate
    );

    // Copy all audio data into combined buffer
    let offset = 0;
    for (const buffer of audioBuffers) {
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        combinedBuffer.getChannelData(channel).set(channelData, offset);
      }
      offset += buffer.length;
    }

    // Convert back to blob
    return audioBufferToBlob(combinedBuffer);
  };

  const audioBufferToBlob = (audioBuffer: AudioBuffer): Promise<Blob> => {
    return new Promise((resolve) => {
      // Encode to standard WAV: use 44.1kHz sample rate and higher bit depth
      const targetSampleRate = 44100;
      const numberOfChannels = 1; // Mono for voice cloning
      const format = 1; // PCM
      const bitDepth = 24; // Higher quality for downstream processing
      
      // Resample to 44.1kHz if needed
      let processedBuffer = audioBuffer;
      if (audioBuffer.sampleRate !== targetSampleRate) {
        processedBuffer = resampleAudioBuffer(audioBuffer, targetSampleRate);
      }
      
      // Convert to mono if stereo
      if (processedBuffer.numberOfChannels > 1) {
        processedBuffer = convertToMono(processedBuffer);
      }
      
      const sampleRate = processedBuffer.sampleRate;

      const bytesPerSample = bitDepth / 8;
      const blockAlign = numberOfChannels * bytesPerSample;
      const byteRate = sampleRate * blockAlign;
      const dataSize = processedBuffer.length * blockAlign;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      // WAV header
      const writeString = (offset: number, string: string) => {
        for (let i = 0; i < string.length; i++) {
          view.setUint8(offset + i, string.charCodeAt(i));
        }
      };

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, format, true);
      view.setUint16(22, numberOfChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitDepth, true);
      writeString(36, 'data');
      view.setUint32(40, dataSize, true);

      // Convert float audio data to 24-bit PCM
      let offset = 44;
      for (let i = 0; i < processedBuffer.length; i++) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
          const sample = Math.max(-1, Math.min(1, processedBuffer.getChannelData(channel)[i]));
          const intSample = Math.round(sample * 8388607);
          view.setUint8(offset, intSample & 0xFF);
          view.setUint8(offset + 1, (intSample >> 8) & 0xFF);
          view.setUint8(offset + 2, (intSample >> 16) & 0xFF);
          offset += 3;
        }
      }

      resolve(new Blob([buffer], { type: 'audio/wav' }));
    });
  };

  const resampleAudioBuffer = (audioBuffer: AudioBuffer, targetSampleRate: number): AudioBuffer => {
    if (audioBuffer.sampleRate === targetSampleRate) {
      return audioBuffer;
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ratio = audioBuffer.sampleRate / targetSampleRate;
    const newLength = Math.round(audioBuffer.length / ratio);
    const newBuffer = audioContext.createBuffer(
      audioBuffer.numberOfChannels,
      newLength,
      targetSampleRate
    );

    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      const inputData = audioBuffer.getChannelData(channel);
      const outputData = newBuffer.getChannelData(channel);

      for (let i = 0; i < newLength; i++) {
        const sourceIndex = i * ratio;
        const index = Math.floor(sourceIndex);
        const fraction = sourceIndex - index;

        if (index + 1 < inputData.length) {
          // Linear interpolation
          outputData[i] = inputData[index] + (inputData[index + 1] - inputData[index]) * fraction;
        } else {
          outputData[i] = inputData[index] || 0;
        }
      }
    }

    return newBuffer;
  };

  const convertToMono = (audioBuffer: AudioBuffer): AudioBuffer => {
    if (audioBuffer.numberOfChannels === 1) {
      return audioBuffer;
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const monoBuffer = audioContext.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
    const monoData = monoBuffer.getChannelData(0);

    // Average all channels to create mono
    for (let i = 0; i < audioBuffer.length; i++) {
      let sum = 0;
      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        sum += audioBuffer.getChannelData(channel)[i];
      }
      monoData[i] = sum / audioBuffer.numberOfChannels;
    }

    return monoBuffer;
  };

  const playAudio = async (audioUrl: string, generationId: string) => {
    try {
      if (playingAudio === generationId) {
        // Stop current audio
        if (audioRef.current) {
          audioRef.current.pause();
          setPlayingAudio(null);
        }
        return;
      }

      // Always try to play the real audio file first
      if (audioUrl && audioRef.current) {
        try {
          // Add authorization header for secure audio serving
          const token = localStorage.getItem("token");
          if (token) {
            // For audio URLs, we need to create a blob URL with auth headers
            const response = await fetch(audioUrl, {
              headers: {
                'Authorization': `Bearer ${token}`,
              },
            });
            
            if (!response.ok) {
              throw new Error(`Failed to load audio: ${response.status}`);
            }
            
            const audioBlob = await response.blob();
            const audioBlobUrl = URL.createObjectURL(audioBlob);
            
            audioRef.current.src = audioBlobUrl;
            setPlayingAudio(generationId);
            
            audioRef.current.onended = () => {
              setPlayingAudio(null);
              URL.revokeObjectURL(audioBlobUrl); // Clean up blob URL
            };
            
            audioRef.current.onerror = () => {
              setPlayingAudio(null);
              URL.revokeObjectURL(audioBlobUrl); // Clean up blob URL
              throw new Error("Audio playback failed");
            };
            
            await audioRef.current.play();
            
            // Show success message
            const currentGenerations = voiceGenerations || [];
            const generation = currentGenerations.find((g) => g.id === generationId);
            const previewText = generation?.text?.substring(0, 60) || "generated speech";
            
            toast({
              title: "🎙️ Playing Cloned Voice",
              description: `Now playing: "${previewText}${(generation?.text?.length ?? 0) > 60 ? '...' : ''}"`,
            });
            
            return;
          }
        } catch (audioError) {
          console.error('Real audio playback failed:', audioError);
          // Fall through to simulation mode
        }
      }

      // Fallback: simulation mode (only if real audio fails)
      setPlayingAudio(generationId);
      
      const currentGenerations = voiceGenerations || [];
      const generation = currentGenerations.find((g) => g.id === generationId);
      const textLength = generation?.text?.length || 50;
      
      // Estimate duration: ~100ms per character (realistic speech rate)
      const estimatedDuration = Math.max(2000, Math.min(textLength * 100, 12000)); // 2-12 seconds
      
      setTimeout(() => {
        setPlayingAudio(null);
      }, estimatedDuration);
      
      const previewText = generation?.text?.substring(0, 60) || "generated speech";
      toast({
        title: "🎵 Simulating Audio",
        description: `Simulated playback: "${previewText}${(generation?.text?.length ?? 0) > 60 ? '...' : ''}"`,
      });
      
    } catch (error) {
      console.error('Audio playback error:', error);
      toast({
        title: "Playback failed",
        description: "Could not play the audio file",
        variant: "destructive",
      });
      setPlayingAudio(null);
    }
  };

  const downloadAudio = (audioUrl: string, text: string) => {
    try {
      const link = document.createElement('a');
      link.href = audioUrl;
      link.download = `voice-generation-${text.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '_')}.wav`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Download error:', error);
      toast({
        title: "Download failed",
        description: "Could not download the audio file",
        variant: "destructive",
      });
    }
  };

  const onGenerateSpeech = (data: VoiceGenerationFormData) => {
    generateSpeechMutation.mutate(data);
  };

  const onCreateFaceProfile = (data: FaceProfileFormData) => {
    if (!imageFile) {
      toast({
        title: "Image file required",
        description: "Please upload a photo for face cloning",
        variant: "destructive",
      });
      return;
    }
    // Face profile creation (placeholder for future implementation)
    console.log('Face profile creation:', { name: data.name, familyId: data.familyId, imageFile });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <audio ref={audioRef} preload="none" />
      <Navigation />
      
      <main className="pt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold gradient-text mb-2">Clone Studio</h1>
            <p className="text-muted-foreground">Create voice clones of family members for personalized videos</p>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList className={FACE_FEATURE_ENABLED ? "grid w-full grid-cols-2" : "grid w-full grid-cols-1"}>
              <TabsTrigger value="voice" data-testid="tab-voice">Voice Cloning</TabsTrigger>
              {FACE_FEATURE_ENABLED && (
                <TabsTrigger value="face" data-testid="tab-face">Face Cloning</TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="voice">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Voice Profile Creation */}
                <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <i className="fas fa-microphone mr-2 text-primary"></i>
                    Create Voice Profile
                  </CardTitle>
                  <CardDescription>Record or upload audio to create a new voice clone</CardDescription>
                </CardHeader>
                <CardContent>
                  {voiceStep === -1 ? (
                    <form onSubmit={profileForm.handleSubmit(onCreateProfile)} className="space-y-4">
                      <div>
                        <Label htmlFor="name">Voice Name</Label>
                        <Input
                          id="name"
                          {...profileForm.register("name")}
                          placeholder="e.g., Grandpa Joe, Mom Sarah"
                          data-testid="input-voice-name"
                        />
                        {profileForm.formState.errors.name && (
                          <p className="text-sm text-destructive mt-1">
                            {profileForm.formState.errors.name.message}
                          </p>
                        )}
                      </div>

                      <div>
                        <Label htmlFor="familyId">Family (Optional)</Label>
                        {!isCreatingFamily ? (
                          <div className="space-y-2">
                            <Select 
                              value={profileForm.watch("familyId")} 
                              onValueChange={(value) => profileForm.setValue("familyId", value)}
                            >
                              <SelectTrigger data-testid="select-family">
                                <SelectValue placeholder="Select a family" />
                              </SelectTrigger>
                              <SelectContent>
                                {(Array.isArray(families) && families.length > 0) ? (
                                  families.map((family: any) => (
                                    <SelectItem key={family.id} value={family.id}>
                                      {family.name}
                                    </SelectItem>
                                  ))
                                ) : (
                                  <div className="p-2 text-sm text-muted-foreground">
                                    No families found
                                  </div>
                                )}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setIsCreatingFamily(true)}
                              className="w-full"
                              data-testid="button-create-family"
                            >
                              <i className="fas fa-plus mr-2"></i>
                              Create New Family
                            </Button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Input
                              placeholder="Enter family name"
                              value={newFamilyName}
                              onChange={(e) => setNewFamilyName(e.target.value)}
                              data-testid="input-family-name"
                            />
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => {
                                  if (newFamilyName.trim()) {
                                    createFamilyMutation.mutate(newFamilyName.trim());
                                  }
                                }}
                                disabled={!newFamilyName.trim() || createFamilyMutation.isPending}
                                className="flex-1"
                                data-testid="button-save-family"
                              >
                                {createFamilyMutation.isPending ? (
                                  <>
                                    <i className="fas fa-spinner fa-spin mr-2"></i>
                                    Creating...
                                  </>
                                ) : (
                                  <>
                                    <i className="fas fa-check mr-2"></i>
                                    Create
                                  </>
                                )}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setIsCreatingFamily(false);
                                  setNewFamilyName("");
                                }}
                                data-testid="button-cancel-family"
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="bg-secondary/20 rounded-lg p-4">
                        <h4 className="font-medium mb-2 flex items-center">
                          <i className="fas fa-check-circle text-green-500 mr-2"></i>
                          Recording Complete!
                        </h4>
                        <p className="text-sm text-muted-foreground mb-3">
                          Successfully recorded {Object.keys(recordedAudios).length} of {VOICE_SENTENCES.length} voice samples
                        </p>
                        <div className="grid grid-cols-4 gap-1 mb-3">
                          {VOICE_SENTENCES.map((_, index) => (
                            <div
                              key={index}
                              className={`h-2 rounded ${
                                recordedAudios[index] ? 'bg-green-500' : 'bg-secondary'
                              }`}
                            />
                          ))}
                        </div>
                      </div>

                      <Button
                        type="submit"
                        className="w-full"
                        disabled={createProfileMutation.isPending || Object.keys(recordedAudios).length === 0}
                        data-testid="button-create-profile"
                      >
                        {createProfileMutation.isPending ? (
                          <>
                            <i className="fas fa-spinner fa-spin mr-2"></i>
                            Creating Voice Profile...
                          </>
                        ) : (
                          <>
                            <i className="fas fa-magic mr-2"></i>
                            Create Voice Profile
                          </>
                        )}
                      </Button>
                    </form>
                  ) : (
                    <div className="space-y-4">
                      {/* Recording Progress */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span>Recording Progress</span>
                          <span>{Math.min(voiceStep + 1, VOICE_SENTENCES.length)} / {VOICE_SENTENCES.length}</span>
                        </div>
                        <div className="w-full bg-secondary rounded-full h-2">
                          <div 
                            className="bg-primary h-2 rounded-full transition-all duration-300"
                            style={{ width: `${((voiceStep + 1) / VOICE_SENTENCES.length) * 100}%` }}
                          />
                        </div>
                      </div>

                      {/* Current Sentence */}
                      <div className="bg-primary/10 rounded-lg p-4 border border-primary/20">
                        <h4 className="font-medium mb-2 flex items-center">
                          <i className="fas fa-quote-left text-primary mr-2"></i>
                          Sentence {voiceStep + 1}
                        </h4>
                        <p className="text-foreground leading-relaxed text-lg">
                          {VOICE_SENTENCES[voiceStep]?.replace('[Your Name]', profileForm.watch('name') || '[Your Name]')}
                        </p>
                      </div>

                      {/* Recording Instructions */}
                      <div className="bg-secondary/20 rounded-lg p-4">
                        <h4 className="font-medium mb-2">Instructions</h4>
                        <ul className="text-sm text-muted-foreground space-y-1">
                          <li>• Speak clearly and naturally</li>
                          <li>• Find a quiet environment</li>
                          <li>• Hold your device 6-8 inches from your mouth</li>
                          <li>• Take your time - you can re-record any sentence</li>
                        </ul>
                      </div>

                      {/* Recording Controls */}
                      <div className="flex gap-3">
                        <Button
                          type="button"
                          variant={isRecording ? "destructive" : "default"}
                          onClick={() => isRecording ? stopVoiceRecording() : startVoiceRecording(voiceStep)}
                          className="flex-1"
                          disabled={voiceStep >= VOICE_SENTENCES.length}
                          data-testid="button-record-sentence"
                        >
                          {isRecording ? (
                            <>
                              <i className="fas fa-stop mr-2"></i>
                              Stop Recording
                            </>
                          ) : (
                            <>
                              <i className="fas fa-microphone mr-2"></i>
                              {recordedAudios[voiceStep] ? 'Re-record' : 'Start Recording'}
                            </>
                          )}
                        </Button>

                        {recordedAudios[voiceStep] && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              if (voiceStep < VOICE_SENTENCES.length - 1) {
                                setVoiceStep(voiceStep + 1);
                              } else {
                                setVoiceStep(-1);
                              }
                            }}
                            data-testid="button-next-sentence"
                          >
                            {voiceStep < VOICE_SENTENCES.length - 1 ? (
                              <>
                                Next <i className="fas fa-arrow-right ml-2"></i>
                              </>
                            ) : (
                              <>
                                Finish <i className="fas fa-check ml-2"></i>
                              </>
                            )}
                          </Button>
                        )}
                      </div>

                      {/* Recorded Samples Grid */}
                      <div className="grid grid-cols-4 gap-2">
                        {VOICE_SENTENCES.map((_, index) => (
                          <div
                            key={index}
                            className={`p-2 rounded-lg border text-center text-xs ${
                              index === voiceStep
                                ? 'border-primary bg-primary/10 text-primary'
                                : recordedAudios[index]
                                ? 'border-green-500 bg-green-500/10 text-green-700'
                                : 'border-secondary bg-secondary/20 text-muted-foreground'
                            }`}
                          >
                            {index === voiceStep && isRecording ? (
                              <i className="fas fa-circle text-red-500 animate-pulse"></i>
                            ) : recordedAudios[index] ? (
                              <i className="fas fa-check"></i>
                            ) : (
                              <i className="fas fa-microphone"></i>
                            )}
                            <div className="mt-1">{index + 1}</div>
                          </div>
                        ))}
                      </div>

                      {/* Skip Option */}
                      <div className="text-center">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setVoiceStep(-1)}
                          className="text-xs"
                          data-testid="button-skip-to-upload"
                        >
                          Skip guided recording and upload file instead
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Voice Profiles List */}
              <Card>
                <CardHeader>
                  <CardTitle>Your Voice Profiles</CardTitle>
                  <CardDescription>Manage your created voice clones</CardDescription>
                </CardHeader>
                <CardContent>
                  {profilesLoading ? (
                    <div className="space-y-3">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
                      ))}
                    </div>
                  ) : Array.isArray(voiceProfiles) && voiceProfiles.length > 0 ? (
                    <div className="space-y-3">
                      {(voiceProfiles || []).map((profile: any) => (
                        <VoiceProfileCard 
                          key={profile.id} 
                          profile={profile}
                          onSelect={() => {
                            setSelectedProfile(profile.id);
                            generationForm.setValue("voiceProfileId", profile.id);
                          }}
                          isSelected={selectedProfile === profile.id}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8" data-testid="text-no-profiles">
                      <i className="fas fa-microphone text-4xl text-muted-foreground mb-4"></i>
                      <p className="text-muted-foreground">No voice profiles yet</p>
                      <p className="text-sm text-muted-foreground">Create your first voice clone above</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Voice Generation */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center">
                    <i className="fas fa-robot mr-2 text-accent"></i>
                    Generate Speech
                  </CardTitle>
                  <CardDescription>Create AI speech using your voice profiles</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={generationForm.handleSubmit(onGenerateSpeech)} className="space-y-4">
                    <div>
                      <Label htmlFor="voiceProfile">Select Voice</Label>
                      <Select 
                        value={generationForm.watch("voiceProfileId")} 
                        onValueChange={(value) => generationForm.setValue("voiceProfileId", value)}
                      >
                        <SelectTrigger data-testid="select-voice-profile">
                          <SelectValue placeholder="Choose a voice profile" />
                        </SelectTrigger>
                        <SelectContent>
                          {(Array.isArray(voiceProfiles) ? voiceProfiles : []).filter((p: any) => p.status === 'ready').map((profile: any) => (
                            <SelectItem key={profile.id} value={profile.id}>
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {generationForm.formState.errors.voiceProfileId && (
                        <p className="text-sm text-destructive mt-1">
                          {generationForm.formState.errors.voiceProfileId.message}
                        </p>
                      )}
                    </div>

                    <div>
                      <div className="space-y-2">
                        <Label htmlFor="story-template">Story template</Label>
                        {storyCatalogLoading ? (
                          <p className="text-sm text-muted-foreground">Loading curated stories…</p>
                        ) : storyCatalogError ? (
                          <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            <span>We couldn't load the story library.</span>
                            <Button variant="outline" size="xs" onClick={() => refetchStoryCatalog()}>
                              Retry
                            </Button>
                          </div>
                        ) : (
                          <Select
                            value={selectedStorySlug || "custom"}
                            onValueChange={(value) => {
                              if (value === "custom") {
                                setSelectedStorySlug("");
                                lastAppliedStorySlugRef.current = null;
                                return;
                              }
                              setSelectedStorySlug(value);
                            }}
                          >
                            <SelectTrigger id="story-template" data-testid="select-story-template">
                              <SelectValue placeholder="Write your own or choose a curated story" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="custom">Write my own script</SelectItem>
                              {(storyCatalog?.stories ?? [])
                                .filter((story) => Boolean(story.slug))
                                .map((story) => (
                                  <SelectItem key={story.slug} value={story.slug}>
                                    {story.title}
                                    {story.category ? ` · ${story.category}` : ""}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        )}
                        {selectedStorySlug && (
                          <p className="text-xs text-muted-foreground">
                            {selectedStoryLoading
                              ? "Fetching story content…"
                              : selectedStory
                              ? "Loaded story content into the text area below."
                              : "Story content will appear in the text area once loaded."}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center justify-between mb-2 mt-4">
                        <Label htmlFor="text">Text to Speak</Label>
                        <div className="flex items-center gap-2">
                          {!selectedProfile && (
                            <span className="text-xs text-muted-foreground">Select a voice first →</span>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              console.log('Generate Story clicked, selectedProfile:', selectedProfile);
                              if (selectedProfile) {
                                console.log('Calling generateStoryMutation with:', selectedProfile);
                                generateStoryMutation.mutate(selectedProfile);
                              } else {
                                console.log('No profile selected');
                                toast({
                                  title: "No voice selected",
                                  description: "Please click on a voice profile card to select it first",
                                  variant: "destructive",
                                });
                              }
                            }}
                            disabled={!selectedProfile || generateStoryMutation.isPending}
                            data-testid="button-generate-story"
                          >
                          {generateStoryMutation.isPending ? (
                            <>
                              <i className="fas fa-spinner fa-spin mr-2"></i>
                              Creating Story...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-magic mr-2"></i>
                              Generate Story
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                    <Textarea
                        id="text"
                        {...generationForm.register("text")}
                        placeholder="Enter the text you want the AI voice to speak, or click 'Generate Story' for an AI-created short story..."
                        className="min-h-[120px]"
                        data-testid="textarea-speech-text"
                      />
                      {generationForm.formState.errors.text && (
                        <p className="text-sm text-destructive mt-1">
                          {generationForm.formState.errors.text.message}
                        </p>
                      )}
                    </div>

                    <Button
                      type="submit"
                      className="w-full"
                      disabled={generateSpeechMutation.isPending || !selectedProfile}
                      data-testid="button-generate-speech"
                    >
                      {generateSpeechMutation.isPending ? (
                        <>
                          <i className="fas fa-spinner fa-spin mr-2"></i>
                          Generating Speech...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-volume-up mr-2"></i>
                          Generate Speech
                        </>
                      )}
                    </Button>
                  </form>
                </CardContent>
              </Card>

              {/* Generated Audio List */}
              {selectedProfile && (
                <Card>
                  <CardHeader>
                    <CardTitle>Generated Audio</CardTitle>
                    <CardDescription>Your AI-generated speech clips</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {Array.isArray(voiceGenerations) && voiceGenerations.length > 0 ? (
                      <div className="space-y-3">
                        {voiceGenerations.map((generation) => (
                          <div key={generation.id} className="bg-secondary/20 rounded-lg p-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <p className="text-sm font-medium mb-1">
                                  {generation.text.substring(0, 50)}...
                                </p>
                                <p className="text-xs text-muted-foreground mb-2">
                                  {generation.createdAt ? new Date(generation.createdAt).toLocaleDateString() : 'No date'}
                                </p>
                                <div className="flex items-center gap-2">
                                  <span className={`px-2 py-1 rounded text-xs ${
                                    generation.status === 'completed' 
                                      ? 'bg-primary/20 text-primary' 
                                      : generation.status === 'processing'
                                      ? 'bg-accent/20 text-accent'
                                      : generation.status === 'failed'
                                      ? 'bg-destructive/20 text-destructive'
                                      : 'bg-muted/20 text-muted-foreground'
                                  }`}>
                                    {generation.status === 'completed' && <i className="fas fa-check mr-1"></i>}
                                    {generation.status === 'processing' && <i className="fas fa-spinner fa-spin mr-1"></i>}
                                    {generation.status === 'failed' && <i className="fas fa-exclamation mr-1"></i>}
                                    {generation.status === 'failed' ? 'Failed' : generation.status}
                                  </span>
                                  {generation.status === 'failed' && generation.metadata && typeof generation.metadata === 'object' && 'error' in generation.metadata ? (
                                    <span className="text-xs text-destructive">
                                      Error: {(generation.metadata as any).error}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="flex gap-2">
                                {generation.status === 'completed' && (
                                  <>
                                    <Button 
                                      variant="ghost" 
                                      size="sm" 
                                      data-testid="button-play-audio"
                                      onClick={() => playAudio(generation.audioUrl || '', generation.id)}
                                      disabled={playingAudio === generation.id}
                                    >
                                      <i className={`fas ${playingAudio === generation.id ? 'fa-pause' : 'fa-play'}`}></i>
                                    </Button>
                                    <Button 
                                      variant="ghost" 
                                      size="sm" 
                                      data-testid="button-download-audio"
                                      onClick={() => generation.audioUrl && downloadAudio(generation.audioUrl, generation.text)}
                                    >
                                      <i className="fas fa-download"></i>
                                    </Button>
                                  </>
                                )}
                                {generation.status === 'failed' && (
                                  <Button 
                                    variant="ghost" 
                                    size="sm" 
                                    data-testid="button-retry-generation"
                                    onClick={() => {
                                      const text = generation.text;
                                      generationForm.setValue("text", text);
                                      toast({
                                        title: "Text restored",
                                        description: "The failed text has been restored to the form. You can try generating again.",
                                      });
                                    }}
                                  >
                                    <i className="fas fa-redo mr-1"></i>
                                    Retry
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8" data-testid="text-no-generations">
                        <i className="fas fa-volume-up text-4xl text-muted-foreground mb-4"></i>
                        <p className="text-muted-foreground mb-2">No audio generations yet</p>
                        <p className="text-sm text-muted-foreground">Generate speech or create a story above to see your audio clips here</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
                </div>
              </div>
            </TabsContent>

            {FACE_FEATURE_ENABLED && (
            <TabsContent value="face">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Face Profile Creation */}
                <div className="space-y-6">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center">
                        <i className="fas fa-camera mr-2 text-primary"></i>
                        Create Face Profile
                      </CardTitle>
                      <CardDescription>Record 360° video to create a realistic face clone</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {!isRecordingFace && !recordedFaceVideo ? (
                        <div className="space-y-4">
                          <form onSubmit={faceForm.handleSubmit(onCreateFaceProfile)} className="space-y-4">
                            <div>
                              <Label htmlFor="faceName">Face Name</Label>
                              <Input
                                id="faceName"
                                {...faceForm.register("name")}
                                placeholder="e.g., Grandpa Joe, Mom Sarah"
                                data-testid="input-face-name"
                              />
                              {faceForm.formState.errors.name && (
                                <p className="text-sm text-destructive mt-1">
                                  {faceForm.formState.errors.name.message}
                                </p>
                              )}
                            </div>

                            <div>
                              <Label htmlFor="faceFamilyId">Family (Optional)</Label>
                              {!isCreatingFamily ? (
                                <div className="space-y-2">
                                  <Select 
                                    value={faceForm.watch("familyId")} 
                                    onValueChange={(value) => faceForm.setValue("familyId", value)}
                                  >
                                    <SelectTrigger data-testid="select-face-family">
                                      <SelectValue placeholder="Select a family" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {(Array.isArray(families) && families.length > 0) ? (
                                        families.map((family: any) => (
                                          <SelectItem key={family.id} value={family.id}>
                                            {family.name}
                                          </SelectItem>
                                        ))
                                      ) : (
                                        <div className="p-2 text-sm text-muted-foreground">
                                          No families found
                                        </div>
                                      )}
                                    </SelectContent>
                                  </Select>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setIsCreatingFamily(true)}
                                    className="w-full"
                                    data-testid="button-create-family-face"
                                  >
                                    <i className="fas fa-plus mr-2"></i>
                                    Create New Family
                                  </Button>
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  <Input
                                    placeholder="Enter family name"
                                    value={newFamilyName}
                                    onChange={(e) => setNewFamilyName(e.target.value)}
                                    data-testid="input-family-name-face"
                                  />
                                  <div className="flex gap-2">
                                    <Button
                                      type="button"
                                      size="sm"
                                      onClick={() => {
                                        if (newFamilyName.trim()) {
                                          createFamilyMutation.mutate(newFamilyName.trim());
                                        }
                                      }}
                                      disabled={!newFamilyName.trim() || createFamilyMutation.isPending}
                                      className="flex-1"
                                      data-testid="button-save-family-face"
                                    >
                                      {createFamilyMutation.isPending ? (
                                        <>
                                          <i className="fas fa-spinner fa-spin mr-2"></i>
                                          Creating...
                                        </>
                                      ) : (
                                        <>
                                          <i className="fas fa-check mr-2"></i>
                                          Create
                                        </>
                                      )}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => {
                                        setIsCreatingFamily(false);
                                        setNewFamilyName("");
                                      }}
                                      data-testid="button-cancel-family-face"
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </form>

                          <div className="bg-primary/10 rounded-lg p-4 border border-primary/20">
                            <h4 className="font-medium mb-2 flex items-center">
                              <i className="fas fa-video text-primary mr-2"></i>
                              360° Face Recording
                            </h4>
                            <p className="text-sm text-muted-foreground mb-4">
                              Record a short video turning your head in all directions for the best face clone quality.
                            </p>
                            <ul className="text-sm text-muted-foreground space-y-1 mb-4">
                              <li>• Find good lighting and face the camera</li>
                              <li>• Follow the on-screen directions</li>
                              <li>• Turn your head slowly and smoothly</li>
                              <li>• Keep a neutral expression</li>
                            </ul>
                            <Button
                              onClick={startFaceRecording}
                              className="w-full"
                              data-testid="button-start-face-recording"
                            >
                              <i className="fas fa-video mr-2"></i>
                              Start 360° Recording
                            </Button>
                          </div>
                        </div>
                      ) : isRecordingFace ? (
                        <div className="space-y-4">
                          {/* Video Preview */}
                          <div className="relative bg-black rounded-lg overflow-hidden">
                            <video
                              ref={videoRef}
                              autoPlay
                              muted
                              className="w-full h-64 object-cover"
                              data-testid="video-preview"
                            />
                            
                            {/* Recording Indicator */}
                            <div className="absolute top-4 left-4 flex items-center bg-red-500 text-white px-3 py-1 rounded-full">
                              <i className="fas fa-circle text-red-200 animate-pulse mr-2"></i>
                              Recording
                            </div>

                            {/* Direction Indicator */}
                            <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black/80 text-white px-4 py-2 rounded-lg text-center">
                              <div className="text-lg font-medium">
                                {FACE_DIRECTIONS[faceStep]?.instruction}
                              </div>
                              <div className="text-sm text-gray-300 mt-1">
                                Step {faceStep + 1} of {FACE_DIRECTIONS.length}
                              </div>
                            </div>
                          </div>

                          {/* Progress Bar */}
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span>Recording Progress</span>
                              <span>{faceStep + 1} / {FACE_DIRECTIONS.length}</span>
                            </div>
                            <div className="w-full bg-secondary rounded-full h-2">
                              <div 
                                className="bg-primary h-2 rounded-full transition-all duration-300"
                                style={{ width: `${((faceStep + 1) / FACE_DIRECTIONS.length) * 100}%` }}
                              />
                            </div>
                          </div>

                          {/* Direction Grid */}
                          <div className="grid grid-cols-4 gap-2">
                            {FACE_DIRECTIONS.map((direction, index) => (
                              <div
                                key={index}
                                className={`p-2 rounded-lg border text-center text-xs ${
                                  index === faceStep
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : index < faceStep
                                    ? 'border-green-500 bg-green-500/10 text-green-700'
                                    : 'border-secondary bg-secondary/20 text-muted-foreground'
                                }`}
                              >
                                {index === faceStep ? (
                                  <i className="fas fa-circle text-red-500 animate-pulse"></i>
                                ) : index < faceStep ? (
                                  <i className="fas fa-check"></i>
                                ) : (
                                  <i className="fas fa-video"></i>
                                )}
                                <div className="mt-1">{direction.angle}</div>
                              </div>
                            ))}
                          </div>

                          <Button
                            onClick={stopFaceRecording}
                            variant="destructive"
                            className="w-full"
                            data-testid="button-stop-face-recording"
                          >
                            <i className="fas fa-stop mr-2"></i>
                            Stop Recording
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="bg-secondary/20 rounded-lg p-4">
                            <h4 className="font-medium mb-2 flex items-center">
                              <i className="fas fa-check-circle text-green-500 mr-2"></i>
                              Recording Complete!
                            </h4>
                            <p className="text-sm text-muted-foreground mb-3">
                              Successfully captured 360° face video
                            </p>
                            
                            {recordedFaceVideo && (
                              <div className="bg-black rounded-lg overflow-hidden mb-3">
                                <video
                                  controls
                                  className="w-full h-32 object-cover"
                                  data-testid="recorded-video-preview"
                                >
                                  <source src={URL.createObjectURL(recordedFaceVideo)} type="video/webm" />
                                </video>
                              </div>
                            )}
                          </div>

                          <div className="flex gap-3">
                            <Button
                              onClick={() => {
                                setRecordedFaceVideo(null);
                                setFaceStep(0);
                              }}
                              variant="outline"
                              className="flex-1"
                              data-testid="button-retake-video"
                            >
                              <i className="fas fa-redo mr-2"></i>
                              Retake
                            </Button>
                            
                            <Button
                              onClick={(e) => {
                                e.preventDefault();
                                if (!recordedFaceVideo) return;
                                
                                // Convert video blob to file and submit
                                const videoFile = new File([recordedFaceVideo], 'face-video.webm', { type: 'video/webm' });
                                const formData = faceForm.getValues();
                                // Store video file for future face profile creation
                                setImageFile(videoFile);
                                onCreateFaceProfile(formData);
                              }}
                              className="flex-1"
                              disabled={createFaceProfileMutation.isPending}
                              data-testid="button-create-face-profile"
                            >
                              {createFaceProfileMutation.isPending ? (
                                <>
                                  <i className="fas fa-spinner fa-spin mr-2"></i>
                                  Creating...
                                </>
                              ) : (
                                <>
                                  <i className="fas fa-magic mr-2"></i>
                                  Create Profile
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Face Profile Info */}
                <div className="space-y-6">
                  <Card>
                    <CardHeader>
                      <CardTitle>Face Cloning</CardTitle>
                      <CardDescription>Create realistic face clones for video personalization</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="text-center py-8">
                        <i className="fas fa-user-circle text-6xl text-muted-foreground mb-4"></i>
                        <h3 className="text-lg font-semibold mb-2">Coming Soon!</h3>
                        <p className="text-muted-foreground text-sm mb-4">
                          Face cloning technology is currently in development. Upload photos now to be ready when it launches.
                        </p>
                        <div className="bg-secondary/20 rounded-lg p-4">
                          <h4 className="font-medium mb-2">What you can expect:</h4>
                          <ul className="text-sm text-muted-foreground space-y-1">
                            <li>• Realistic face swapping in videos</li>
                            <li>• Multiple photo angles for better results</li>
                            <li>• Family member face libraries</li>
                            <li>• AI-powered face generation</li>
                          </ul>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>
            )}
          </Tabs>
        </div>
      </main>
    </div>
  );
}
