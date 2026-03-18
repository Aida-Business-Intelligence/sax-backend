import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import warehouseRoutes from './routes/warehouse.js';
import clientRoutes from './routes/client.js';
import usersRoutes from './routes/users.js';
import rolesRoutes from './routes/roles.js';
import proprietariosRoutes from './routes/proprietarios.js';
import sectionsRoutes from './routes/sections.js';
import tagsRoutes from './routes/tags.js';
import propertiesPublicRoutes from './routes/properties-public.js';
import propriedadesRoutes from './routes/propriedades.js';
import siteConfigRoutes from './routes/site-config.js';

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);
app.use(express.json());

// Arquivos enviados (imagens de imóveis, logos, etc.)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { success: false, message: 'Muitas requisições. Tente novamente em alguns minutos.' },
  })
);

// Rotas públicas (login e listagem de lojas para o select no login)
app.use('/api/auth', authRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/proprietarios', proprietariosRoutes);
app.use('/api/sections', sectionsRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/properties', propertiesPublicRoutes);
app.use('/api/propriedades', propriedadesRoutes);
app.use('/api/site-config', siteConfigRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'sax-backend' });
});

app.use(errorHandler);

export default app;
