import { nanoid } from 'nanoid';
import { storage } from '../storage';
import { voiceService } from './voiceService';
import { logger } from '../utils/logger-simple';
import { metricsService } from './metricsService-simple';

export interface VoiceJobData {
  id: string;
  name: string;
  userId: string;
  familyId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  stage: string;
  estimatedTime?: number;
  startTime: Date;
  completedTime?: Date;
  error?: string;
  result?: {
    voiceId: string;
    sampleUrl: string;
    qualityScore: number;
  };
  recordings: {
    id: string;
    duration: number;
    quality: {
      score: number;
      issues: string[];
      recommendations: string[];
    };
  }[];
  audioFiles?: Buffer[]; // Store audio data for processing
}

class VoiceJobService {
  private jobs: Map<string, VoiceJobData> = new Map();
  private processingQueue: string[] = [];
  private isProcessing = false;

  async createJob(
    name: string,
    userId: string,
    recordings: Array<{
      buffer: Buffer;
      metadata: {
        id: string;
        duration: number;
        quality: {
          score: number;
          issues: string[];
          recommendations: string[];
        };
      };
    }>,
    familyId?: string
  ): Promise<VoiceJobData> {
    const jobId = nanoid();
    
    const job: VoiceJobData = {
      id: jobId,
      name,
      userId,
      familyId,
      status: 'pending',
      progress: 0,
      stage: 'pending',
      estimatedTime: this.calculateEstimatedTime(recordings),
      startTime: new Date(),
      recordings: recordings.map(r => ({
        id: r.metadata.id,
        duration: r.metadata.duration,
        quality: r.metadata.quality,
      })),
      audioFiles: recordings.map(r => r.buffer), // Store audio data
    };

    this.jobs.set(jobId, job);
    this.processingQueue.push(jobId);

    logger.info('Voice job created', {
      jobId,
      userId,
      name,
      recordingCount: recordings.length,
    });

    metricsService.recordMetric({
      name: 'voice_jobs_created_total',
      value: 1,
      unit: 'count',
      tags: { userId }
    });

    // Start processing if not already running
    this.processQueue();

    return job;
  }

  private calculateEstimatedTime(recordings: Array<{ metadata: { duration: number } }>): number {
    const totalDuration = recordings.reduce((sum, r) => sum + r.metadata.duration, 0);
    
    // Base processing time: 30 seconds + 2x audio duration
    // Additional time for quality analysis and TTS processing
    const baseTime = 30;
    const processingMultiplier = 2;
    const processingOverhead = 45; // TTS pipeline overhead (approx)
    
    return baseTime + (totalDuration * processingMultiplier) + processingOverhead;
  }

  private async processQueue() {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.processingQueue.length > 0) {
      const jobId = this.processingQueue.shift()!;
      const job = this.jobs.get(jobId);

      if (!job) {
        continue;
      }

      try {
        await this.processJob(job);
      } catch (error) {
        logger.error('Job processing failed', {
          jobId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    this.isProcessing = false;
  }

  private async processJob(job: VoiceJobData) {
    try {
      logger.info('Starting job processing', { jobId: job.id });

      // Update job status
      job.status = 'processing';
      job.stage = 'uploading';
      job.progress = 10;

      // Simulate processing stages with realistic timing
      await this.updateJobStage(job, 'preprocessing', 25);
      
      // Get the original audio files (this would normally be stored with the job)
      // For now, we'll simulate this step
      await this.simulateProcessingDelay(2000);
      
      await this.updateJobStage(job, 'training', 50);
      
      // Call the actual voice service with real audio files
      const startTime = Date.now();
      
      if (!job.audioFiles || job.audioFiles.length === 0) {
        throw new Error('No audio files available for processing');
      }

      // Process voice cloning with real audio files
      const result = await this.processVoiceCloning(job, job.audioFiles);
      
      await this.updateJobStage(job, 'validation', 80);
      await this.simulateProcessingDelay(2000);
      
      await this.updateJobStage(job, 'finalizing', 95);
      await this.simulateProcessingDelay(1000);

      // Complete the job
      job.status = 'completed';
      job.progress = 100;
      job.stage = 'completed';
      job.completedTime = new Date();
      job.result = result;

      const processingTime = Date.now() - startTime;
      
      logger.info('Job completed successfully', {
        jobId: job.id,
        processingTime,
        qualityScore: job.result.qualityScore,
      });

      metricsService.recordMetric({
        name: 'voice_jobs_completed_total',
        value: 1,
        unit: 'count',
        tags: { userId: job.userId }
      });

      metricsService.recordMetric({
        name: 'voice_job_processing_duration_ms',
        value: processingTime,
        unit: 'milliseconds',
        tags: { userId: job.userId }
      });

    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Processing failed';
      job.completedTime = new Date();

      logger.error('Job processing failed', {
        jobId: job.id,
        error: job.error,
      });

      metricsService.recordMetric({
        name: 'voice_jobs_failed_total',
        value: 1,
        unit: 'count',
        tags: { userId: job.userId, error_type: 'processing_error' }
      });
    }
  }

  private async updateJobStage(job: VoiceJobData, stage: string, progress: number) {
    job.stage = stage;
    job.progress = progress;
    
    logger.debug('Job stage updated', {
      jobId: job.id,
      stage,
      progress,
    });

    // Simulate processing time for this stage
    await this.simulateProcessingDelay(1000 + Math.random() * 2000);
  }

  private async simulateProcessingDelay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async processVoiceCloning(job: VoiceJobData, audioFiles: Buffer[]) {
    try {
      logger.info('Processing voice cloning with Chatterbox TTS', {
        jobId: job.id,
        audioFileCount: audioFiles.length
      });

      // Send multiple recordings to improve clone quality (Chatterbox aggregates signals)
      // Use the method that supports multiple files directly for better quality
      const voiceProfileId = await voiceService.createVoiceCloneFromFiles(
        audioFiles,
        job.name,
        job.userId,
        job.familyId,
        job.recordings
      );

      // Get the created voice profile for quality score
      const voiceProfile = await storage.getVoiceProfile(voiceProfileId);
      
      if (!voiceProfile) {
        throw new Error('Voice profile creation failed');
      }
      
      logger.info('Voice clone created successfully', {
        jobId: job.id,
        voiceProfileId,
        modelId: voiceProfile.modelId
      });
      
      return {
        voiceId: voiceProfile.modelId || `voice_${nanoid()}`,
        qualityScore: this.calculateOverallQuality(job.recordings),
        sampleUrl: voiceProfile.audioSampleUrl || `/api/voice-samples/${job.id}/sample.wav`,
      };
    } catch (error) {
      logger.error('Voice cloning failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Provide specific error messages based on the error type
      if (error instanceof Error) {
        if (error.message.includes('TTS') || error.message.includes('voice cloning')) {
          throw new Error('Voice cloning service error: Please try again later');
        } else if (error.message.includes('quality')) {
          throw new Error('Audio quality insufficient: Please record with clearer audio');
        } else if (error.message.includes('API key')) {
          throw new Error('Voice cloning service configuration error: Please contact support');
        } else if (error.message.includes('credits')) {
          throw new Error('Voice cloning service credits exhausted: Please try again later');
        }
      }
      
      throw new Error('Voice cloning failed: Please try again or contact support');
    }
  }

  private async combineAudioFiles(audioFiles: Buffer[]): Promise<Buffer> {
    if (audioFiles.length === 1) {
      return audioFiles[0];
    }

    // Use the existing audio processing logic from voiceService
    // This is a simplified version - in practice, you'd use the web worker
    // or a server-side audio processing library
    
    // For now, return the first file as the combined result
    // In production, implement proper audio concatenation
    return audioFiles[0];
  }

  private calculateOverallQuality(recordings: VoiceJobData['recordings']): number {
    if (recordings.length === 0) return 0;
    
    const totalScore = recordings.reduce((sum, rec) => sum + rec.quality.score, 0);
    return Math.round(totalScore / recordings.length);
  }

  getJob(jobId: string): VoiceJobData | undefined {
    return this.jobs.get(jobId);
  }

  getJobsByUser(userId: string): VoiceJobData[] {
    return Array.from(this.jobs.values()).filter(job => job.userId === userId);
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.status === 'pending') {
      // Remove from queue
      const queueIndex = this.processingQueue.indexOf(jobId);
      if (queueIndex > -1) {
        this.processingQueue.splice(queueIndex, 1);
      }
      
      job.status = 'failed';
      job.error = 'Cancelled by user';
      job.completedTime = new Date();

      logger.info('Job cancelled', { jobId });
      
      metricsService.recordMetric({
        name: 'voice_jobs_cancelled_total',
        value: 1,
        unit: 'count',
        tags: { userId: job.userId }
      });

      return true;
    }

    // Cannot cancel processing jobs (in a real implementation, 
    // you might be able to interrupt the processing)
    return false;
  }

  async retryJob(jobId: string): Promise<VoiceJobData | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'failed') return null;

    // Reset job state
    job.status = 'pending';
    job.progress = 0;
    job.stage = 'pending';
    job.error = undefined;
    job.result = undefined;
    job.startTime = new Date();
    job.completedTime = undefined;

    // Add back to queue
    this.processingQueue.push(jobId);

    logger.info('Job retried', { jobId });

    metricsService.recordMetric({
      name: 'voice_jobs_retried_total',
      value: 1,
      unit: 'count',
      tags: { userId: job.userId }
    });

    // Start processing
    this.processQueue();

    return job;
  }

  getQueueStatus() {
    return {
      queueLength: this.processingQueue.length,
      isProcessing: this.isProcessing,
      totalJobs: this.jobs.size,
      jobsByStatus: {
        pending: Array.from(this.jobs.values()).filter(j => j.status === 'pending').length,
        processing: Array.from(this.jobs.values()).filter(j => j.status === 'processing').length,
        completed: Array.from(this.jobs.values()).filter(j => j.status === 'completed').length,
        failed: Array.from(this.jobs.values()).filter(j => j.status === 'failed').length,
      }
    };
  }

  // Cleanup old jobs (call this periodically)
  cleanupOldJobs(maxAge: number = 7 * 24 * 60 * 60 * 1000) { // 7 days default
    const cutoff = new Date(Date.now() - maxAge);
    const jobsToDelete: string[] = [];

    for (const [jobId, job] of Array.from(this.jobs.entries())) {
      if (job.completedTime && job.completedTime < cutoff) {
        jobsToDelete.push(jobId);
      }
    }

    jobsToDelete.forEach(jobId => {
      this.jobs.delete(jobId);
    });

    if (jobsToDelete.length > 0) {
      logger.info('Cleaned up old jobs', { count: jobsToDelete.length });
    }
  }
}

export const voiceJobService = new VoiceJobService();

// Cleanup old jobs every hour
setInterval(() => {
  voiceJobService.cleanupOldJobs();
}, 60 * 60 * 1000);
