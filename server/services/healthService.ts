import { logger } from '../utils/logger';
import { promises as fs } from 'fs';
import { constants as fsConstants } from 'fs';
import { join } from 'path';
import type { Config } from '../config';

export interface HealthCheck {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime?: number;
  error?: string;
  details?: Record<string, any>;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  checks: HealthCheck[];
  system: {
    memory: {
      used: number;
      total: number;
      percentage: number;
    };
    cpu: {
      usage: number;
    };
    disk: {
      used: number;
      total: number;
      percentage: number;
    };
  };
}

class HealthService {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  async getSystemHealth(): Promise<SystemHealth> {
    // Lazily import config so tests can mock it
    const { config } = await import('../config');
    const checks: HealthCheck[] = [];
    
    // Database health check
    const dbHealth = await this.checkDatabase();
    checks.push(dbHealth);

    // File system health check
    const fsHealth = await this.checkFileSystem(config);
    checks.push(fsHealth);

    // External API health checks
    if (config.OPENAI_API_KEY) {
      const openAIHealth = await this.checkOpenAI(config);
      checks.push(openAIHealth);
    }

    // Determine overall status
    const overallStatus = this.determineOverallStatus(checks);

    // Get system metrics
    const systemMetrics = await this.getSystemMetrics();

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: Date.now() - this.startTime,
      checks,
      system: systemMetrics
    };
  }

  private async checkDatabase(): Promise<HealthCheck> {
    try {
      // Lazily import to allow Vitest mocking to take effect
      const { checkDatabaseHealth } = await import('../db/connection');
      const result = await checkDatabaseHealth();
      return {
        service: 'database',
        status: result.status,
        responseTime: result.responseTime,
        error: result.error,
        details: {
          type: 'PostgreSQL',
          poolSize: 20 // From connection config
        }
      };
    } catch (error) {
      logger.error('Database health check failed:', error);
      return {
        service: 'database',
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async checkFileSystem(config: Config): Promise<HealthCheck> {
    try {
      const startTime = Date.now();
      const uploadDir = join(process.cwd(), config.UPLOAD_DIR);
      
      // Check if upload directory exists and is writable
      await fs.access(uploadDir, fsConstants.W_OK);
      
      // Try to write a test file
      const testFile = join(uploadDir, '.health-check');
      await fs.writeFile(testFile, 'health-check');
      await fs.unlink(testFile);
      
      const responseTime = Date.now() - startTime;
      
      return {
        service: 'filesystem',
        status: 'healthy',
        responseTime,
        details: {
          uploadDir,
          writable: true
        }
      };
    } catch (error) {
      logger.error('File system health check failed:', error);
      return {
        service: 'filesystem',
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Removed ElevenLabs health check

  private async checkOpenAI(config: Config): Promise<HealthCheck> {
    try {
      const startTime = Date.now();
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.OPENAI_API_KEY}`
        },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      const responseTime = Date.now() - startTime;

      if (response.ok) {
        return {
          service: 'openai',
          status: 'healthy',
          responseTime,
          details: {
            endpoint: 'https://api.openai.com/v1/models'
          }
        };
      } else {
        return {
          service: 'openai',
          status: 'degraded',
          responseTime,
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }
    } catch (error) {
      logger.error('OpenAI API health check failed:', error);
      return {
        service: 'openai',
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private determineOverallStatus(checks: HealthCheck[]): 'healthy' | 'degraded' | 'unhealthy' {
    const unhealthyCount = checks.filter(c => c.status === 'unhealthy').length;
    const degradedCount = checks.filter(c => c.status === 'degraded').length;

    // If any critical service is unhealthy, system is unhealthy
    const criticalServices = ['database', 'filesystem'];
    const criticalUnhealthy = checks
      .filter(c => criticalServices.includes(c.service) && c.status === 'unhealthy')
      .length > 0;

    if (criticalUnhealthy || unhealthyCount > 1) {
      return 'unhealthy';
    }

    if (unhealthyCount > 0 || degradedCount > 0) {
      return 'degraded';
    }

    return 'healthy';
  }

  private async getSystemMetrics() {
    const memoryUsage = process.memoryUsage();
    
    return {
      memory: {
        used: memoryUsage.heapUsed,
        total: memoryUsage.heapTotal,
        percentage: (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100
      },
      cpu: {
        usage: process.cpuUsage().user / 1000000 // Convert to seconds
      },
      disk: {
        used: 0, // Would need additional library to get disk usage
        total: 0,
        percentage: 0
      }
    };
  }

  // Simplified health check for load balancers
  async getSimpleHealth(): Promise<{ status: string; timestamp: string }> {
    try {
      const { checkDatabaseHealth } = await import('../db/connection');
      const dbHealth = await checkDatabaseHealth();
      return {
        status: dbHealth.status === 'healthy' ? 'ok' : 'error',
        timestamp: new Date().toISOString()
      };
    } catch {
      return {
        status: 'error',
        timestamp: new Date().toISOString()
      };
    }
  }
}

export const healthService = new HealthService();
