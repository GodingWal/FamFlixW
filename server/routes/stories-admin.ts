import { Router } from 'express';
import multer from 'multer';
import { authenticateToken, AuthRequest } from '../middleware/auth-simple.js';
import { storage } from '../storage';
import { storyCategories, rightsStatuses } from '../db/schema';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const CATEGORY_SET = new Set(storyCategories.map((category) => category.toUpperCase()));
const RIGHTS_SET = new Set(rightsStatuses.map((status) => status.toUpperCase()));

function normalizeCategory(value?: string | null): string {
    if (!value) {
        return 'custom';
    }
    const normalized = value.trim().toUpperCase();
    return CATEGORY_SET.has(normalized) ? normalized : 'custom';
}

function parseTags(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item));
    }

    if (typeof value === 'string' && value.trim() !== '') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item));
        }
      } catch {
        return value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }

    return [];
}

router.post('/api/stories-admin', authenticateToken, upload.single('story'), async (req: AuthRequest, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ error: 'You do not have permission to perform this action.' });
        }

        const storyFile = req.file;
        if (!storyFile) {
            return res.status(400).json({ error: 'Story file is required (field name: story)' });
        }

        const { title, author, summary, category, tags } = req.body as any;
        if (!title || String(title).trim().length === 0) {
            return res.status(400).json({ error: 'Title is required' });
        }

        const storyContent = storyFile.buffer.toString('utf-8');
        const sections = storyContent.split('\n\n').map((text, index) => ({
            text: text.trim(),
            index
        }));

        const slug = String(title).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').slice(0, 60) || 'story';

        const story = await storage.createStory({
            title: String(title),
            slug,
            author: author ? String(author) : undefined,
            summary: summary ? String(summary) : undefined,
            category: normalizeCategory(category),
            rights: 'LICENSED',
            tags: parseTags(tags),
            content: storyContent,
        });

        for (const section of sections) {
            await storage.createStorySection({
                storyId: story.id,
                sectionIndex: section.index,
                text: section.text,
                wordCount: section.text.split(/\s+/).filter(Boolean).length,
            });
        }

        res.status(201).json(story);
    } catch (error) {
        console.error('Upload story error:', error);
        res.status(500).json({ error: 'Failed to upload story' });
    }
});

export default router;
