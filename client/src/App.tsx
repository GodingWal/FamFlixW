import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Suspense, lazy } from "react";
import { LoadingSpinner } from "@/components/ui/loading";
import { HelmetProvider } from "react-helmet-async";

// Code splitting - lazy load pages
const Landing = lazy(() => import("@/pages/Landing"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Login = lazy(() => import("@/pages/Login"));
const VideoSelectionCatalog = lazy(() => import("@/pages/VideoSelectionCatalog"));
const ProjectSetup = lazy(() => import("@/pages/ProjectSetup"));
const VoiceCloning = lazy(() => import("@/pages/VoiceCloningEnhanced"));
const VideoLibrary = lazy(() => import("@/pages/VideoLibrary"));
const VideoDetails = lazy(() => import("@/pages/VideoDetails"));
const Profile = lazy(() => import("@/pages/Profile"));
const Settings = lazy(() => import("@/pages/Settings"));
const Stories = lazy(() => import("@/pages/Stories"));
const Pricing = lazy(() => import("@/pages/Pricing"));
const Privacy = lazy(() => import("@/pages/Privacy"));
const Terms = lazy(() => import("@/pages/Terms"));
const Contact = lazy(() => import("@/pages/Contact"));
const NotFound = lazy(() => import("@/pages/not-found"));
const AdminDashboard = lazy(() => import("@/pages/AdminDashboard"));
const AdminTemplateUpload = lazy(() => import("@/pages/AdminTemplateUpload"));
const AdminStoryUpload = lazy(() => import("@/pages/AdminStoryUpload"));
import { useAuth } from "@/hooks/useAuth";

function Router() {
  const { isAuthenticated } = useAuth();

  return (
    <ErrorBoundary>
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      }>
        <Switch>
          <Route path="/">
            {isAuthenticated ? <Dashboard /> : <Landing />}
          </Route>
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/login" component={Login} />
          <Route path="/videos" component={VideoLibrary} />
          <Route path="/videos/:id" component={VideoDetails} />
          <Route path="/create" component={VideoSelectionCatalog} />
          <Route path="/projects/:id/setup" component={ProjectSetup} />
                 <Route path="/admin" component={AdminDashboard} />
                 <Route path="/admin/upload-templates" component={AdminTemplateUpload} />
                 <Route path="/admin/upload-story" component={AdminStoryUpload} />
          <Route path="/voice-cloning" component={VoiceCloning} />
          <Route path="/stories" component={Stories} />
          <Route path="/pricing" component={Pricing} />
          <Route path="/profile" component={Profile} />
          <Route path="/settings" component={Settings} />
          <Route path="/privacy" component={Privacy} />
          <Route path="/terms" component={Terms} />
          <Route path="/contact" component={Contact} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <HelmetProvider>
              <Toaster />
              <Router />
            </HelmetProvider>
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
