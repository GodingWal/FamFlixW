import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { config } from "../config";
import { logger } from "../utils/logger";

const extractBearerToken = (authHeader: string): string | undefined => {
  const parts = authHeader
    .trim()
    .split(/\s+/)
    .filter(part => part.length > 0);

  if (parts.length < 2) {
    return undefined;
  }

  const [scheme, token] = parts;

  if (scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
};

const assertSecret = (name: "JWT_SECRET" | "JWT_REFRESH_SECRET") => {
  const value = config[name];
  if (!value || value.length < 32) {
    const message = `${name} is not configured with a secure value`;
    logger.error(message);
    throw new Error(message);
  }
  return value;
};

const JWT_SECRET = assertSecret("JWT_SECRET");
const JWT_REFRESH_SECRET = assertSecret("JWT_REFRESH_SECRET");

interface TokenPayload {
  userId: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  // First try to get token from Authorization header
  const authHeader = req.headers["authorization"];
  let token = typeof authHeader === 'string' ? extractBearerToken(authHeader) : undefined;
  
  // If not in header, try to get from httpOnly cookie
  if (!token && req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }

  if (!token) {
    // Attempt transparent refresh if a valid refresh token cookie is present
    const refreshTokenCookie = req.cookies?.refreshToken;
    if (refreshTokenCookie) {
      try {
        const decoded = verifyRefreshToken(refreshTokenCookie);
        const user = await storage.getUser(decoded.userId);
        if (user && user.isActive) {
          const newAccessToken = generateAccessToken(user.id);
          // Set new access token cookie
          res.cookie('accessToken', newAccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 15 * 60 * 1000, // 15 minutes
          });
          // Attach user to request and continue
          req.user = {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role || "user",
          };
          return next();
        }
      } catch {
        // Fall through to 401 below
      }
    }
    return res.status(401).json({ error: "Access token required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
    
    if (decoded.type && decoded.type !== 'access') {
      throw new Error('Invalid token type');
    }

    const user = await storage.getUser(decoded.userId);
    
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Invalid or inactive user" });
    }

    req.user = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role || "user",
    };
    
    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: "Token expired", 
        code: "TOKEN_EXPIRED" 
      });
    }
    
    return res.status(403).json({ error: "Invalid token" });
  }
};

export const generateAccessToken = (userId: string): string => {
  return jwt.sign(
    { userId, type: 'access' }, 
    JWT_SECRET, 
    { expiresIn: '15m' }
  );
};

export const generateRefreshToken = (userId: string): string => {
  return jwt.sign(
    { userId, type: 'refresh' }, 
    JWT_REFRESH_SECRET, 
    { expiresIn: '7d' }
  );
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
  
  if (decoded.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  
  return decoded;
};

export const refreshTokens = async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;
    
    if (!refreshToken) {
      return res.status(401).json({ error: "Refresh token required" });
    }

    const decoded = verifyRefreshToken(refreshToken);
    const user = await storage.getUser(decoded.userId);
    
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Invalid user" });
    }

    const newAccessToken = generateAccessToken(user.id);
    const newRefreshToken = generateRefreshToken(user.id);

    // Set httpOnly cookies
    res.cookie('accessToken', newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes
    });

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({
      message: "Tokens refreshed successfully",
      accessToken: newAccessToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    });
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: "Refresh token expired", 
        code: "REFRESH_TOKEN_EXPIRED" 
      });
    }
    
    return res.status(401).json({ error: "Invalid refresh token" });
  }
};

export const requireRole = (roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
};
