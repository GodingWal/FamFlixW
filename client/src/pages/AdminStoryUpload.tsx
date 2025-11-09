import React, { useEffect, useMemo, useState } from 'react';
import {
  Upload,
  Book,
  Sparkles,
  Tags,
  Filter,
  Search,
  Library,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { Navigation } from '@/components/Navigation';

type Story = {
  id: number;
  title: string;
  author?: string;
  category?: string;
  tags?: string[];
  summary?: string;
  createdAt?: string;
};

const defaultCategories = ['bedtime', 'classic', 'fairytale', 'adventure', 'educational', 'custom'];

export default function AdminStoryUpload() {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [summary, setSummary] = useState('');
  const [category, setCategory] = useState('bedtime');
  const [tags, setTags] = useState('');

  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');

  const canSubmit = Boolean(file && title.trim().length > 0 && !uploading);

  useEffect(() => {
    const checkAdmin = async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (!res.ok) {
          setIsAdmin(false);
          return;
        }
        const me = await res.json();
        setIsAdmin(me.role === 'admin');
      } catch {
        setIsAdmin(false);
      }
    };
    checkAdmin();
  }, []);

  const loadStories = async () => {
    setStoriesLoading(true);
    try {
      const res = await fetch('/api/stories', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch stories');
      const data = await res.json();
      const sorted = data.stories.slice().sort((a: Story, b: Story) => {
        const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bDate - aDate;
      });
      setStories(sorted);
    } catch (fetchError) {
      console.error(fetchError);
      toast({
        title: 'Unable to load library',
        description: 'Stories are temporarily unavailable.',
        variant: 'destructive',
      });
    } finally {
      setStoriesLoading(false);
    }
  };

  useEffect(() => {
    loadStories();
  }, []);

  const existingCategories = useMemo(() => {
    const categorySet = new Set<string>();
    stories.forEach((story) => {
      if (story.category) categorySet.add(story.category);
    });
    defaultCategories.forEach((preset) => categorySet.add(preset));
    return Array.from(categorySet).sort();
  }, [stories]);

  const parsedTagPreview = useMemo(() => {
    if (!tags.trim()) return [];
    try {
      const json = JSON.parse(tags);
      if (Array.isArray(json)) {
        return json.map((tag) => String(tag));
      }
    } catch {
      // ignore JSON parse errors, fallback to comma-separated
    }
    return tags.split(',').map((tag) => tag.trim()).filter(Boolean);
  }, [tags]);

  const filteredStories = useMemo(() => {
    return stories.filter((story) => {
      if (filterCategory !== 'all' && story.category !== filterCategory) return false;
      if (!searchTerm.trim()) return true;
      const haystack = `${story.title} ${story.summary ?? ''} ${(story.tags ?? []).join(' ')}`.toLowerCase();
      return haystack.includes(searchTerm.toLowerCase());
    });
  }, [stories, filterCategory, searchTerm]);

  const storiesCount = stories.length;
  const lastUploadedAt = stories[0]?.createdAt ? new Date(stories[0].createdAt).toLocaleDateString() : '—';

  const handleCategoryChip = (value: string) => {
    setCategory(value);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || uploading) return;

    setError(null);
    setSuccess(null);
    setUploading(true);

    try {
      const form = new FormData();
      form.append('story', file);
      form.append('title', title);

      if (author) form.append('author', author);
      if (summary) form.append('summary', summary);
      if (category) form.append('category', category);

      if (tags) {
        try {
          const json = JSON.parse(tags);
          form.append('tags', JSON.stringify(json));
        } catch {
          const normalized = tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
          form.append('tags', JSON.stringify(normalized));
        }
      }

      const res = await fetch('/api/stories-admin', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Upload failed');
      }

      setSuccess('Story uploaded successfully.');
      toast({
        title: 'Story published',
        description: `"${title}" is now available in the story library.`,
      });

      setTitle('');
      setAuthor('');
      setSummary('');
      setTags('');
      setFile(null);

      await loadStories();
    } catch (submitError: any) {
      const message = submitError?.message || 'Failed to upload story.';
      setError(message);
      toast({
        title: 'Upload failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  if (isAdmin === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="rounded-xl border bg-card px-6 py-4 text-sm text-muted-foreground shadow-sm">
          Checking administrative access…
        </div>
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>You need administrator privileges to manage stories.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
        <Navigation />
      <div className="container mx-auto space-y-10 py-10">
        <section className="relative overflow-hidden rounded-3xl border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-8 shadow-sm">
          <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-primary/20 blur-3xl lg:block" />
          <div className="relative z-10 grid gap-6 lg:grid-cols-[2fr_1fr]">
            <div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles className="h-4 w-4 text-primary" />
                Curated Story Library
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground lg:text-4xl">
                Upload new stories
              </h1>
              <p className="mt-2 text-sm text-muted-foreground lg:pr-10">
                Upload markdown files to instantly update the story catalog.
              </p>
            </div>
            <div className="grid gap-3 rounded-2xl border bg-card/80 p-4 text-sm shadow-sm backdrop-blur">
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="gap-1">
                  <Book className="h-3.5 w-3.5" />
                  {storiesCount} total
                </Badge>
              </div>
              <p className="font-medium text-foreground">Latest update</p>
              <p className="text-xs text-muted-foreground">Last upload recorded on {lastUploadedAt}</p>
            </div>
          </div>
        </section>

        <div className="grid gap-8">
          <Card>
            <CardHeader>
              <CardTitle>Story metadata & file</CardTitle>
              <CardDescription>
                Upload the markdown file, add descriptive context, and choose how it should appear in the public catalog.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-6" onSubmit={handleSubmit}>
                <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Story file</label>
                    <Input
                      type="file"
                      accept=".md"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Upload a markdown file.
                    </p>
                  </div>

                <div className="grid gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Story title</label>
                    <Input
                      placeholder="The Tortoise and the Hare"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Author</label>
                    <Input
                      placeholder="Aesop"
                      value={author}
                      onChange={(event) => setAuthor(event.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Summary</label>
                    <Textarea
                      placeholder="A short summary of the story."
                      value={summary}
                      onChange={(event) => setSummary(event.target.value)}
                      className="min-h-[120px]"
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Category</label>
                    <Input
                      placeholder="classic"
                      value={category}
                      onChange={(event) => setCategory(event.target.value)}
                    />
                    <div className="flex flex-wrap gap-2 pt-1">
                      {existingCategories.slice(0, 6).map((option) => (
                        <Button
                          key={option}
                          type="button"
                          variant={option === category ? 'default' : 'secondary'}
                          size="sm"
                          className="h-8 px-3 text-xs"
                          onClick={() => handleCategoryChip(option)}
                        >
                          {option}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">
                      Tags (JSON array or comma separated)
                    </label>
                    <Input
                      placeholder='["fable","moral"] or fable, moral'
                      value={tags}
                      onChange={(event) => setTags(event.target.value)}
                    />
                  </div>
                </div>

                {error && (
                  <Alert variant="destructive">
                    <AlertTitle>Upload failed</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                {success && (
                  <Alert>
                    <AlertTitle>Success</AlertTitle>
                    <AlertDescription>{success}</AlertDescription>
                  </Alert>
                )}

                <div className="flex items-center justify-end gap-3">
                  <Button type="button" variant="outline" onClick={loadStories} disabled={uploading}>
                    Refresh library
                  </Button>
                  <Button type="submit" disabled={!canSubmit}>
                    {uploading ? (
                      <>
                        <Upload className="mr-2 h-4 w-4 animate-spin" />
                        Uploading…
                      </>
                    ) : (
                      <>
                        <Upload className="mr-2 h-4 w-4" />
                        Publish story
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <CardTitle>Story library</CardTitle>
                <CardDescription>Filter and review the catalog.</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-60">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search stories…"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                </div>
                <Select value={filterCategory} onValueChange={setFilterCategory}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {existingCategories.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="ghost" className="gap-2" type="button" onClick={() => {
                  setSearchTerm('');
                  setFilterCategory('all');
                }}>
                  <Filter className="h-4 w-4" />
                  Reset
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {storiesLoading ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[...Array(6)].map((_, index) => (
                  <Skeleton key={index} className="h-48 rounded-xl" />
                ))}
              </div>
            ) : filteredStories.length === 0 ? (
              <div className="rounded-xl border border-dashed bg-muted/20 p-10 text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">No stories match your filters</p>
                <p>Adjust the search or add a new story to populate this library.</p>
              </div>
            ) : (
              <ScrollArea className="max-h-[480px]">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {filteredStories.map((story) => (
                    <div key={story.id} className="flex flex-col rounded-2xl border bg-card/80 p-4 shadow-sm transition hover:border-primary/30 hover:shadow">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground line-clamp-2">{story.title}</p>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{story.summary || 'No summary provided.'}</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {story.category && (
                          <Badge variant="outline" className="gap-1">
                            <Library className="h-3 w-3" />
                            {story.category}
                          </Badge>
                        )}
                      </div>
                      {Array.isArray(story.tags) && story.tags.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1">
                          {story.tags.slice(0, 4).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[10px]">
                              #{tag}
                            </Badge>
                          ))}
                          {story.tags.length > 4 && (
                            <Badge variant="outline" className="text-[10px]">
                              +{story.tags.length - 4}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
