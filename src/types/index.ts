export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  apiSecretKey?: string;
}

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  uptime: number;
}
