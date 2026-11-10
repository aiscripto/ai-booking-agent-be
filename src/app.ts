import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { apiRouter } from './routes';
import { errorMiddleware } from './middlewares/error.middleware';

const app = express();

// The frontend nginx sits in front of this app, on a private Docker address. Trust the
// X-Forwarded-For header ONLY when the connection comes from a private or loopback address.
// A client that reaches this port directly from the internet has a public address, so its
// forged header is ignored and the login rate limits cannot be avoided (audit SEC-013).
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// Standard middleware stack
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging based on environment
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Register API Routes
app.use('/api/v1', apiRouter);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Wildcard fallback for 404 Not Found errors
app.use((req, res, next) => {
  const error: any = new Error(`Route not found: ${req.method} ${req.path}`);
  error.statusCode = 404;
  next(error);
});

// Global Error Handler
app.use(errorMiddleware);

export default app;
