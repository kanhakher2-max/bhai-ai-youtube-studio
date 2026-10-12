import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { ClerkProvider, SignedIn, SignedOut, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { shadcn } from '@clerk/themes';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BookOpenText,
  CircleAlert, Clapperboard, Clock3, CloudOff, Film, FolderKanban,
  Gauge, LoaderCircle, LogOut, Menu, MoreHorizontal, Plus, RefreshCw, Save, Send,
  Settings2, ShieldCheck, Sparkles, Trash2, Upload, UsersRound, X,
} from 'lucide-react';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import {
  getGetStudioOverviewQueryKey, getGetStudioProjectQueryKey, getListProjectScenesQueryKey,
  getListStudioCharactersQueryKey, getListStudioJobsQueryKey, getListStudioProjectsQueryKey,
  useCancelStudioJob, useCreateProjectScene, useCreateSceneBreakdownJob,
  useCreateStoryGenerationJob, useCreateStudioCharacter, useCreateStudioProject,
  useDeleteStudioCharacter, useDeleteStudioProject, useDeleteStudioScene,
  useExportStudioBackup, useGetStudioEngines, useGetStudioOverview, useGetStudioProject,
  useGetYouTubeAnalytics, useGetYouTubeStatus, useListProjectScenes, useListStudioCharacters,
  useListStudioJobs, useListStudioProjects, useRestoreStudioBackup, useRetryStudioJob,
  useUpdateStudioCharacter, useUpdateStudioProject, useUpdateStudioScene,
} from '@workspace/api-client-react';
import type { StudioBackup, StudioCharacter, StudioProject, StudioScene } from '@workspace/api-client-react';
import './index.css';
import './studio.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');

const appearance = {
  theme: shadcn, cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
  variables: {
    colorPrimary: '#d87d62', colorForeground: '#2b3039', colorMutedForeground: '#727477', colorDanger: '#b6483f',
    colorBackground: '#f7f3ec', colorInput: '#fbf8f3', colorInputForeground: '#2b3039', colorNeutral: '#d8d1c5',
    fontFamily: 'DM Sans', borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center', cardBox: 'bg-[#f7f3ec] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none', footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#252a34] font-bold', headerSubtitle: 'text-[#6d6f70]', socialButtonsBlockButtonText: 'text-[#30343c]',
    formFieldLabel: 'text-[#30343c] font-medium', footerActionLink: 'text-[#b95e48]', footerActionText: 'text-[#6d6f70]',
    dividerText: 'text-[#6d6f70]', identityPreviewEditButton: 'text-[#b95e48]', formFieldSuccessText: 'text-[#347c69]',
    alertText: 'text-[#8f3832]', logoBox: 'mb-2', logoImage: 'max-h-10', socialButtonsBlockButton: 'border-[#d8d1c5] bg-[#fbf8f3]',
    formButtonPrimary: 'bg-[#d87d62] text-[#242b35] hover:bg-[#df8a70]', formFieldInput: 'bg-[#fbf8f3] border-[#d8d1c5] text-[#30343c]',
    footerAction: 'text-[#6d6f70]', dividerLine: 'bg-[#ded8ce]', alert: 'border-[#e3aaa0]', otpCodeFieldInput: 'bg-[#fbf8f3]',
    formFieldRow: 'mb-4', main: 'gap-5',
  },
};

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <Link href="/" className={`brand-lockup ${inverse ? 'brand-inverse' : ''}`} aria-label="BHAI AI home">
    <span className="brand-mark">B</span><span><b>BHAI AI</b><small>YOUTUBE STUDIO</small></span>
  </Link>;
}
function IconButton({ children, label, onClick, disabled = false }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return <button className="icon-button" aria-label={label} title={label} data-testid={`button-${label.toLowerCase().replaceAll(' ', '-')}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Button({ children, onClick, type = 'button', variant = 'primary', disabled = false, className = '' }: {
  children: ReactNode; onClick?: () => void; type?: 'button' | 'submit'; variant?: 'primary' | 'soft' | 'quiet' | 'danger'; disabled?: boolean; className?: string;
}) {
  return <button type={type} onClick={onClick} disabled={disabled} className={`button button-${variant} ${className}`}>{children}</button>;
}
function QueryState({ loading, error, retry, children }: { loading: boolean; error: unknown; retry: () => void; children: ReactNode }) {
  if (loading) return <div className="loading-panel"><LoaderCircle className="spin" size={18} /><span>Loading saved studio data</span></div>;
  if (error) return <div className="state-panel state-error"><CircleAlert size={21} /><div><b>Could not reach the studio service</b><p>{error instanceof Error ? error.message : 'The API returned an error. Your saved work has not been changed.'}</p><Button variant="soft" onClick={retry}><RefreshCw size={15} /> Try again</Button></div></div>;
  return <>{children}</>;
}
function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}
function EmptyState({ icon: Icon, title, detail, action }: { icon: typeof Film; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={21} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  return <div className="dialog-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="dialog-card" role="dialog" aria-modal="true" aria-label={title}>
    <header><div><span className="eyebrow">STUDIO INPUT</span><h2>{title}</h2></div><IconButton label="Close dialog" onClick={close}><X size={18} /></IconButton></header>{children}
  </section></div>;
}

function Landing() {
  return <main className="landing-page">
    <header className="landing-nav"><Brand /><nav><a href="#workflow">The workflow</a><a href="#principles">Built for the maker</a><Link className="landing-login" href="/sign-in">Sign in <ArrowRight size={15} /></Link></nav></header>
    <section className="landing-hero">
      <div className="hero-copy"><div className="overline"><span className="live-dot" /> YOUR STORY, FRAME BY FRAME</div><h1>Make room<br />for the <em>story.</em></h1>
        <p>A quiet production desk for Hindi and Hinglish creators. Shape the script, map every scene, and keep your original stories moving.</p>
        <div className="hero-actions"><Link className="button button-primary" href="/sign-up">Open your studio <ArrowRight size={16} /></Link><a className="text-link" href="#workflow">See how it works <ArrowDownToLine size={15} /></a></div>
        <div className="hero-footnote"><span className="tiny-rule" /> YOUR WORK STAYS YOURS <span className="tiny-rule" /></div>
      </div>
      <div className="storyboard" aria-label="Illustrated storyboarding workspace">
        <div className="board-top"><span>STORYBOARD / 001</span><span className="board-status"><i /> IN DEVELOPMENT</span></div>
        <div className="board-art"><div className="moon" /><div className="hill hill-back" /><div className="hill hill-front" /><div className="silhouette" /><div className="story-caption"><span>SCENE 04 · NIGHT EXT.</span><b>The last train home</b><small>“Kuch raaste ghar le jaate hain.”</small></div><span className="frame-index">04</span></div>
        <div className="board-bottom"><div><small>VISUAL TREATMENT</small><b>Cinematic · still &amp; intimate</b></div><div className="audio-pulse"><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/><span/></div><span className="mono">00:18</span></div>
        <div className="board-note">A workspace, not a black box.<br /><b>Every decision stays in your hands.</b></div>
      </div>
    </section>
    <section className="landing-proof" id="principles"><span>ORIGINAL NARRATION</span><i/><span>SCENE-BY-SCENE THINKING</span><i/><span>LOCAL-FIRST ENGINES</span><i/><span>CREATOR APPROVAL, ALWAYS</span></section>
    <section className="landing-workflow" id="workflow"><div className="section-intro"><span className="eyebrow">A BETTER KIND OF PRODUCTION DESK</span><h2>From a spark<br />to a <em>shooting script.</em></h2><p>No invented previews. No pretend progress bars. Just your real production records, clearly in view.</p></div>
      <div className="workflow-list"><article><span>01</span><div><h3>Start with the idea</h3><p>Set the language, genre, visual treatment, and runtime. Let your own voice lead.</p></div><BookOpenText /></article><article><span>02</span><div><h3>Write, then shape</h3><p>Edit the script yourself. When a configured engine is available, queue a generation job and follow its real status.</p></div><Clapperboard /></article><article><span>03</span><div><h3>Plan each frame</h3><p>Break a saved script into scenes, then refine action, camera, ambience, and narration.</p></div><Film /></article></div>
    </section>
    <section className="landing-last"><div><span className="eyebrow">A SOLO CREATOR'S CONTROL ROOM</span><h2>Original stories.<br /><em>On your terms.</em></h2></div><Link className="button button-primary" href="/sign-up">Make something worth telling <ArrowRight size={16} /></Link></section>
    <footer className="landing-footer"><Brand /><span>Built for the long take.</span><span>BHĀI / STORY STUDIO · 01</span></footer>
  </main>;
}

function HomeRoute() {
  return <><SignedOut><Landing /></SignedOut><SignedIn><Redirect to="/studio" /></SignedIn></>;
}
function SignInPage() { return <div className="auth-page"><Brand /><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>; }
function SignUpPage() { return <div className="auth-page"><Brand /><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>; }
function LogoutControl() {
  const { signOut } = useClerk();
  return <button className="nav-link signout-link" onClick={() => signOut({ redirectUrl: basePath || '/' })}><LogOut size={17} /><span>Sign out</span></button>;
}
const navItems = [
  { href: '/studio', title: 'Overview', icon: Gauge },
  { href: '/projects', title: 'Projects', icon: FolderKanban },
  { href: '/characters', title: 'Characters', icon: UsersRound },
  { href: '/jobs', title: 'Job queue', icon: Activity },
  { href: '/publishing', title: 'YouTube', icon: Send },
  { href: '/settings', title: 'Settings', icon: Settings2 },
];
function StudioShell({ children }: { children: ReactNode }) {
  const [location] = useLocation(); const [mobileOpen, setMobileOpen] = useState(false); const { user } = useUser();
  return <div className="studio-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}><div className="sidebar-head"><Brand inverse /><IconButton label="Close menu" onClick={() => setMobileOpen(false)}><X size={17} /></IconButton></div>
      <div className="sidebar-label">WORKSPACE</div><nav className="side-nav">{navItems.map(({ href, title, icon: Icon }) => <Link key={href} href={href} className={`nav-link ${location === href || (href === '/projects' && location.startsWith('/projects/')) ? 'nav-active' : ''}`} onClick={() => setMobileOpen(false)}><Icon size={17} /><span>{title}</span>{href === '/jobs' && <span className="nav-dot" />}</Link>)}</nav>
      <div className="sidebar-bottom"><div className="local-badge"><span className="live-dot" /><div><b>YOUR CREATOR DESK</b><small>Local engines, when available</small></div></div><div className="profile-row"><div className="avatar">{(user?.firstName || user?.emailAddresses[0]?.emailAddress || 'B').slice(0, 1).toUpperCase()}</div><div className="profile-copy"><b>{user?.firstName || 'Creator'}</b><small>Solo storyteller</small></div><LogoutControl /></div></div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <main className="studio-main"><header className="mobile-header"><IconButton label="Open menu" onClick={() => setMobileOpen(true)}><Menu size={19} /></IconButton><Brand /><span className="mobile-status"><i /></span></header>
      <div className="workspace-top"><span className="breadcrumb">BHAI AI <b>/</b> STUDIO</span><div><span className="status-pill"><span className="live-dot" /> PRIVATE WORKSPACE</span><span className="today-date">{new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</span></div></div>
      <div className="main-content page-enter">{children}</div>
    </main>
  </div>;
}
function Protected({ children }: { children: ReactNode }) {
  return <><SignedIn><StudioShell>{children}</StudioShell></SignedIn><SignedOut><Redirect to="/" /></SignedOut></>;
}

type ProjectFields = { title: string; idea: string; language: 'Hindi' | 'Hinglish' | 'English'; genre: string; targetMinutes: 5 | 6 | 7 | 8; visualStyle: '2d' | '3d-cartoon' | 'anime' | 'cinematic' };
const initialProject: ProjectFields = { title: '', idea: '', language: 'Hinglish', genre: 'Drama', targetMinutes: 6, visualStyle: 'cinematic' };
function ProjectForm({ submit, busy, close }: { submit: (data: ProjectFields) => void; busy: boolean; close: () => void }) {
  const [form, setForm] = useState<ProjectFields>(initialProject);
  const change = (key: keyof ProjectFields, value: string) => setForm((old) => ({ ...old, [key]: key === 'targetMinutes' ? Number(value) : value } as ProjectFields));
  return <form onSubmit={(e: FormEvent) => { e.preventDefault(); submit(form); }} className="form-stack">
    <label>Project title<input autoFocus required maxLength={160} value={form.title} onChange={(e) => change('title', e.target.value)} placeholder="A story title" /></label>
    <label>The idea<textarea required maxLength={5000} value={form.idea} onChange={(e) => change('idea', e.target.value)} placeholder="What happens, and why does it matter?" rows={4} /></label>
    <div className="form-grid"><label>Language<select value={form.language} onChange={(e) => change('language', e.target.value)}><option>Hinglish</option><option>Hindi</option><option>English</option></select></label><label>Genre<input required maxLength={80} value={form.genre} onChange={(e) => change('genre', e.target.value)} /></label></div>
    <div className="form-grid"><label>Target runtime<select value={form.targetMinutes} onChange={(e) => change('targetMinutes', e.target.value)}>{[5, 6, 7, 8].map((n) => <option value={n} key={n}>{n} minutes</option>)}</select></label><label>Visual style<select value={form.visualStyle} onChange={(e) => change('visualStyle', e.target.value)}><option value="cinematic">Cinematic</option><option value="2d">2D</option><option value="3d-cartoon">3D cartoon</option><option value="anime">Anime</option></select></label></div>
    <div className="dialog-actions"><Button variant="quiet" onClick={close}>Cancel</Button><Button type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />} Create project <ArrowRight size={15} /></Button></div>
  </form>;
}
function StatusTag({ status }: { status: string }) { return <span className={`status-tag status-${status}`}>{status.replaceAll('_', ' ')}</span>; }
function ProjectCard({ project, onDelete }: { project: StudioProject; onDelete?: (p: StudioProject) => void }) {
  return <article className="project-card" data-testid={`card-project-${project.id}`}><Link href={`/projects/${project.id}`} className="project-card-link">
    <div className={`project-cover cover-${project.visualStyle}`}><div className="cover-orbit" /><span>{project.genre || 'STORY'}</span><small>{project.language}</small><div className="cover-number">{project.title.slice(0, 1).toUpperCase()}</div></div>
    <div className="project-card-body"><div className="project-title-row"><h3>{project.title}</h3><StatusTag status={project.status} /></div><p>{project.idea || 'No premise added yet.'}</p><div className="project-meta"><span><Clock3 size={13} /> {project.targetMinutes} min</span><span>{project.visualStyle.replace('-', ' ')}</span><span>{new Date(project.updatedAt).toLocaleDateString()}</span></div></div>
  </Link>{onDelete && <button aria-label={`Delete ${project.title}`} className="project-delete" onClick={() => onDelete(project)}><Trash2 size={15} /></button>}</article>;
}
function createProject(project: ReturnType<typeof useCreateStudioProject>, queryClient: ReturnType<typeof useQueryClient>, data: ProjectFields, onCreated?: (p: StudioProject) => void) {
  project.mutate({ data }, { onSuccess: (p) => { queryClient.invalidateQueries({ queryKey: getListStudioProjectsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); onCreated?.(p); } });
}

function Dashboard() {
  const queryClient = useQueryClient(); const [, setLocation] = useLocation(); const overview = useGetStudioOverview(); const projects = useListStudioProjects(); const engines = useGetStudioEngines();
  const create = useCreateStudioProject(); const remove = useDeleteStudioProject(); const [showCreate, setShowCreate] = useState(false);
  const deleteProject = (p: StudioProject) => { if (window.confirm(`Delete “${p.title}” and its editable records? This cannot be undone.`)) remove.mutate({ id: p.id }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListStudioProjectsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); } }); };
  const failed = overview.isError || projects.isError;
  return <><PageHeading eyebrow="YOUR STORY DESK / TODAY" title="Good work starts here." description="A clear view of the stories in motion, and the next frame to shape." action={<Button onClick={() => setShowCreate(true)}><Plus size={16} /> New project</Button>} />
    {engines.data && <div className={`engine-strip ${engines.data.some((e) => e.available) ? 'engine-ready' : ''}`}><span className="engine-icon"><Activity size={17} /></span><div><b>{engines.data.some((e) => e.available) ? 'A local engine is ready' : 'Your local engines, honestly reported'}</b><small>{engines.data.length ? engines.data.filter((e) => e.available).length + ' of ' + engines.data.length + ' configured engines available' : 'No engine records returned yet'}</small></div><Link href="/settings">Engine health <ArrowRight size={14} /></Link></div>}
    <QueryState loading={overview.isLoading || projects.isLoading} error={failed ? overview.error || projects.error : null} retry={() => { overview.refetch(); projects.refetch(); }}>
      <div className="metric-grid">{[{ label: 'Projects', value: overview.data?.projectCount ?? projects.data?.length ?? 0, icon: FolderKanban, detail: 'saved in your studio' }, { label: 'Scenes', value: overview.data?.scenes ?? '—', icon: Film, detail: 'across your stories' }, { label: 'Active jobs', value: overview.data?.activeJobs ?? '—', icon: Activity, detail: 'real queue status' }, { label: 'Needs attention', value: overview.data?.failedJobs ?? '—', icon: CircleAlert, detail: 'failed jobs' }].map(({ label, value, icon: Icon, detail }, i) => <div className={`metric metric-${i}`} key={label}><div className="metric-top"><span>{label}</span><Icon size={16} /></div><b>{value}</b><small>{detail}</small></div>)}</div>
      <section className="section-block"><div className="section-heading"><div><span className="eyebrow">IN THE CUT</span><h2>Recent projects</h2></div><Link className="subtle-link" href="/projects">All projects <ArrowRight size={15} /></Link></div>
        {projects.data?.length ? <div className="project-grid">{projects.data.slice(0, 3).map((p) => <ProjectCard key={p.id} project={p} onDelete={deleteProject} />)}</div> : <EmptyState icon={Clapperboard} title="The first story starts with one idea." detail="Create a project to set its language, target runtime, and visual direction." action={<Button onClick={() => setShowCreate(true)}><Plus size={15} /> Start a project</Button>} />}
      </section>
      <section className="recent-jobs"><div className="section-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>Jobs from your studio</h2></div><Link className="subtle-link" href="/jobs">Queue history <ArrowRight size={15} /></Link></div>
        {overview.data?.recentJobs.length ? <div className="job-list">{overview.data.recentJobs.slice(0, 4).map((job) => <div className="job-row" key={job.id}><div className={`job-icon job-${job.status}`}><Sparkles size={16} /></div><div className="job-main"><b>{job.type.replace('_', ' ')} <small>· {job.projectId}</small></b><span>{job.message || 'No additional status detail'}</span></div><StatusTag status={job.status} /><time>{new Date(job.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>)}</div> : <div className="quiet-empty"><span>NO JOBS YET</span><p>Generation and scene jobs will appear here only after the API accepts them.</p></div>}
      </section>
    </QueryState>
    {showCreate && <Dialog title="A new story begins" close={() => setShowCreate(false)}><ProjectForm busy={create.isPending} close={() => setShowCreate(false)} submit={(data) => createProject(create, queryClient, data, (p) => { setShowCreate(false); setLocation(`/projects/${p.id}`); })} /></Dialog>}
  </>;
}

function ProjectsPage() {
  const queryClient = useQueryClient(); const projects = useListStudioProjects(); const create = useCreateStudioProject(); const remove = useDeleteStudioProject(); const [showCreate, setShowCreate] = useState(false);
  const deleteProject = (p: StudioProject) => { if (window.confirm(`Delete “${p.title}” and its editable records?`)) remove.mutate({ id: p.id }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListStudioProjectsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); } }); };
  return <><PageHeading eyebrow="PRODUCTION / PROJECTS" title="Stories in progress." description="Each project is a working room for its script, scenes, and production notes." action={<Button onClick={() => setShowCreate(true)}><Plus size={16} /> New project</Button>} />
    <QueryState loading={projects.isLoading} error={projects.error} retry={() => projects.refetch()}>{projects.data?.length ? <div className="project-grid all-projects">{projects.data.map((p) => <ProjectCard key={p.id} project={p} onDelete={deleteProject} />)}</div> : <EmptyState icon={FolderKanban} title="A story needs a place to take shape." detail="Your saved projects will stay together here." action={<Button onClick={() => setShowCreate(true)}><Plus size={15} /> New project</Button>} />}</QueryState>
    {showCreate && <Dialog title="A new story begins" close={() => setShowCreate(false)}><ProjectForm busy={create.isPending} close={() => setShowCreate(false)} submit={(data) => createProject(create, queryClient, data, () => setShowCreate(false))} /></Dialog>}
  </>;
}

function SceneEditor({ projectId, scene, onClose }: { projectId: string; scene?: StudioScene; onClose: () => void }) {
  const client = useQueryClient(); const create = useCreateProjectScene(); const update = useUpdateStudioScene();
  const [fields, setFields] = useState({ title: scene?.title || '', durationSeconds: scene?.durationSeconds || 30, action: scene?.action || '', dialogue: scene?.dialogue || '', narration: scene?.narration || '', background: scene?.background || '', camera: scene?.camera || '', visualPrompt: scene?.visualPrompt || '', audioNotes: scene?.audioNotes || '' });
  const set = (key: keyof typeof fields, value: string) => setFields((old) => ({ ...old, [key]: key === 'durationSeconds' ? Number(value) : value }));
  const busy = create.isPending || update.isPending;
  return <Dialog title={scene ? `Scene ${scene.sequence.toString().padStart(2, '0')}` : 'Add a scene'} close={onClose}><form className="form-stack" onSubmit={(e) => { e.preventDefault(); const data = { ...fields, sequence: scene?.sequence }; const done = () => { client.invalidateQueries({ queryKey: getListProjectScenesQueryKey(projectId) }); client.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); onClose(); }; if (scene) update.mutate({ id: scene.id, data }, { onSuccess: done }); else create.mutate({ id: projectId, data: { ...data, sequence: data.sequence ?? 1 } }, { onSuccess: done }); }}>
    <label>Scene title<input required maxLength={160} value={fields.title} onChange={(e) => set('title', e.target.value)} /></label><div className="form-grid"><label>Duration (seconds)<input type="number" min={1} max={600} value={fields.durationSeconds} onChange={(e) => set('durationSeconds', e.target.value)} /></label><label>Background<textarea rows={2} value={fields.background} onChange={(e) => set('background', e.target.value)} /></label></div>
    <label>Action<textarea rows={3} value={fields.action} onChange={(e) => set('action', e.target.value)} /></label><div className="form-grid"><label>Dialogue<textarea rows={3} value={fields.dialogue} onChange={(e) => set('dialogue', e.target.value)} /></label><label>Narration<textarea rows={3} value={fields.narration} onChange={(e) => set('narration', e.target.value)} /></label></div>
    <div className="form-grid"><label>Camera notes<textarea rows={2} value={fields.camera} onChange={(e) => set('camera', e.target.value)} /></label><label>Audio notes<textarea rows={2} value={fields.audioNotes} onChange={(e) => set('audioNotes', e.target.value)} /></label></div><label>Visual prompt<input value={fields.visualPrompt} onChange={(e) => set('visualPrompt', e.target.value)} /></label>
    <div className="dialog-actions"><Button variant="quiet" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} Save scene</Button></div>
  </form></Dialog>;
}
function ProjectDetail() {
  const params = useParams<{ id: string }>(); const id = params.id || ''; const client = useQueryClient();
  const project = useGetStudioProject(id, { query: { enabled: !!id, queryKey: getGetStudioProjectQueryKey(id) } });
  const scenes = useListProjectScenes(id, { query: { enabled: !!id, queryKey: getListProjectScenesQueryKey(id) } });
  const engines = useGetStudioEngines(); const update = useUpdateStudioProject(); const storyJob = useCreateStoryGenerationJob(); const breakdown = useCreateSceneBreakdownJob(); const deleteScene = useDeleteStudioScene();
  const [script, setScript] = useState<string | null>(null); const [sceneModal, setSceneModal] = useState<StudioScene | null | 'new'>(null); const [savedNote, setSavedNote] = useState('');
  if (project.isLoading) return <QueryState loading error={null} retry={() => project.refetch()}><div /></QueryState>;
  if (project.error || !project.data) return <QueryState loading={false} error={project.error || new Error('Project not found')} retry={() => project.refetch()}><div /></QueryState>;
  const p = project.data; const text = script ?? p.scriptText ?? ''; const words = text.trim() ? text.trim().split(/\s+/).length : 0; const target = p.targetMinutes * 120; const engineAvailable = engines.data?.some((e) => e.available) || false;
  const saveScript = () => { update.mutate({ id, data: { scriptText: text } }, { onSuccess: () => { setScript(null); setSavedNote('Script saved to this project.'); client.invalidateQueries({ queryKey: getGetStudioProjectQueryKey(id) }); client.invalidateQueries({ queryKey: getListStudioProjectsQueryKey() }); } }); };
  const generate = () => storyJob.mutate({ id, data: { idea: p.idea, language: p.language, genre: p.genre, targetMinutes: p.targetMinutes, visualStyle: p.visualStyle } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListStudioJobsQueryKey({}) }); client.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); } });
  const makeScenes = () => breakdown.mutate({ id }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListStudioJobsQueryKey({}) }); client.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); } });
  return <><Link href="/projects" className="back-link"><ArrowLeft size={15} /> All projects</Link><PageHeading eyebrow={`PROJECT / ${p.language.toUpperCase()} · ${p.genre.toUpperCase()}`} title={p.title} description={p.idea || 'Add an idea to give this story its direction.'} action={<StatusTag status={p.status} />} />
    <div className="project-workspace"><section className="editor-panel"><div className="panel-heading"><div><span className="eyebrow">THE SCRIPT</span><h2>Keep the voice yours.</h2></div><span className="runtime-label"><Clock3 size={14} /> {p.targetMinutes} min target</span></div>
      <div className="script-stats"><span>{words.toLocaleString()} words</span><span>~{Math.ceil(words / 120)} min at 120 wpm</span><span>{target.toLocaleString()} words suggested</span></div>
      <textarea className="script-editor" value={text} onChange={(e) => { setScript(e.target.value); setSavedNote('Unsaved changes'); }} placeholder="Write your narration here. This editor never writes story content for you." />
      <div className="editor-footer"><span className={savedNote === 'Unsaved changes' ? 'unsaved' : ''}>{update.isPending ? 'Saving…' : savedNote || `Last updated ${new Date(p.updatedAt).toLocaleString()}`}</span><Button onClick={saveScript} disabled={update.isPending || text === (p.scriptText || '')}><Save size={15} /> Save script</Button></div>
      <div className="generator-callout"><div className="generator-symbol"><Sparkles size={17} /></div><div><b>Story generation is an actual engine job.</b><p>{engineAvailable ? 'A local engine reports as available. Queue this project idea; no story is shown until the API returns it.' : 'No available engine is reported. Configure and start a local language model before queuing story generation.'}</p></div><Button variant="soft" onClick={generate} disabled={!engineAvailable || storyJob.isPending || !p.idea.trim()}>{storyJob.isPending ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />} Queue story</Button></div>
      {storyJob.isError && <p className="inline-error">Could not queue story job. {String(storyJob.error)}</p>}
    </section>
    <aside className="project-rail"><div className="rail-card"><span className="eyebrow">PROJECT NOTES</span><div className="rail-data"><small>LANGUAGE</small><b>{p.language}</b></div><div className="rail-data"><small>VISUAL DIRECTION</small><b>{p.visualStyle.replace('-', ' ')}</b></div><div className="rail-data"><small>GENRE</small><b>{p.genre}</b></div><div className="rail-data"><small>CREATED</small><b>{new Date(p.createdAt).toLocaleDateString()}</b></div><Link href="/settings" className="subtle-link">Engine health <ArrowRight size={14} /></Link></div></aside></div>
    <section className="section-block scene-section"><div className="section-heading"><div><span className="eyebrow">SHOT LIST / {scenes.data?.length || 0} SCENES</span><h2>Scene timeline</h2></div><div className="scene-actions"><Button variant="soft" onClick={makeScenes} disabled={!engineAvailable || !p.scriptText.trim() || breakdown.isPending}>{breakdown.isPending ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Queue breakdown</Button><Button onClick={() => setSceneModal('new')}><Plus size={15} /> Add scene</Button></div></div>
      <div className="engine-note"><CircleAlert size={15} /> Scene breakdown needs a saved script and an available local engine. It creates a queue job, not an instant preview.</div>
      <QueryState loading={scenes.isLoading} error={scenes.error} retry={() => scenes.refetch()}>{scenes.data?.length ? <div className="scene-timeline">{scenes.data.slice().sort((a, b) => a.sequence - b.sequence).map((s, i) => <article className="scene-row" key={s.id} data-testid={`scene-${s.id}`}><div className="scene-number">{String(s.sequence).padStart(2, '0')}<i /></div><div className="scene-content"><div className="scene-title-row"><h3>{s.title}</h3><span><Clock3 size={13} /> {s.durationSeconds}s</span></div><p>{s.action || s.narration || s.dialogue || 'Add a scene action, dialogue, or narration.'}</p><div className="scene-tags">{s.background && <span>{s.background}</span>}{s.camera && <span>{s.camera}</span>}</div></div><div className="scene-tools"><IconButton label="Edit scene" onClick={() => setSceneModal(s)}><MoreHorizontal size={17} /></IconButton><IconButton label="Delete scene" onClick={() => { if (window.confirm(`Delete scene “${s.title}”?`)) deleteScene.mutate({ id: s.id }, { onSuccess: () => client.invalidateQueries({ queryKey: getListProjectScenesQueryKey(id) }) }); }}><Trash2 size={15} /></IconButton></div></article>)}</div> : <EmptyState icon={Film} title="No scenes mapped yet." detail="Add scenes manually, or save a script and use a configured engine to queue a scene breakdown." />}</QueryState>
    </section>
    {sceneModal && <SceneEditor projectId={id} scene={sceneModal === 'new' ? undefined : sceneModal} onClose={() => setSceneModal(null)} />}
  </>;
}

type CharacterFields = { name: string; description: string; appearance: string; voiceNotes: string; visualStyle: string };
function CharacterDialog({ value, close }: { value?: StudioCharacter; close: () => void }) {
  const client = useQueryClient(); const add = useCreateStudioCharacter(); const edit = useUpdateStudioCharacter();
  const [form, setForm] = useState<CharacterFields>({ name: value?.name || '', description: value?.description || '', appearance: value?.appearance || '', voiceNotes: value?.voiceNotes || '', visualStyle: value?.visualStyle || '' });
  const set = (key: keyof CharacterFields, val: string) => setForm((old) => ({ ...old, [key]: val }));
  return <Dialog title={value ? 'Refine character' : 'Create a character profile'} close={close}><form className="form-stack" onSubmit={(e) => { e.preventDefault(); const done = () => { client.invalidateQueries({ queryKey: getListStudioCharactersQueryKey() }); close(); }; if (value) edit.mutate({ id: value.id, data: form }, { onSuccess: done }); else add.mutate({ data: form }, { onSuccess: done }); }}>
    <label>Character name<input required maxLength={120} autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} /></label><label>Character notes<textarea rows={3} maxLength={5000} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Who are they, and what changes them?" /></label><label>Appearance<textarea rows={3} value={form.appearance} onChange={(e) => set('appearance', e.target.value)} placeholder="A written visual reference; no image is attached." /></label><div className="form-grid"><label>Voice notes<textarea rows={2} value={form.voiceNotes} onChange={(e) => set('voiceNotes', e.target.value)} /></label><label>Visual style<input value={form.visualStyle} onChange={(e) => set('visualStyle', e.target.value)} placeholder="Cinematic, charcoal..." /></label></div>
    <div className="dialog-actions"><Button variant="quiet" onClick={close}>Cancel</Button><Button type="submit" disabled={add.isPending || edit.isPending}>{add.isPending || edit.isPending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} Save profile</Button></div>
  </form></Dialog>;
}
function CharactersPage() {
  const client = useQueryClient(); const query = useListStudioCharacters(); const remove = useDeleteStudioCharacter(); const [active, setActive] = useState<StudioCharacter | null | 'new'>(null);
  return <><PageHeading eyebrow="CAST / STORY BIBLE" title="Characters worth remembering." description="Keep recurring character descriptions and voice direction close at hand." action={<Button onClick={() => setActive('new')}><Plus size={15} /> New character</Button>} />
    <QueryState loading={query.isLoading} error={query.error} retry={() => query.refetch()}>{query.data?.length ? <div className="character-grid">{query.data.map((c, i) => <article className="character-card" key={c.id} data-testid={`character-${c.id}`}><div className={`character-mark character-mark-${i % 4}`}>{c.name.slice(0, 1).toUpperCase()}</div><div className="character-copy"><div className="character-top"><h3>{c.name}</h3><div><IconButton label={`Edit ${c.name}`} onClick={() => setActive(c)}><MoreHorizontal size={17} /></IconButton><IconButton label={`Delete ${c.name}`} onClick={() => { if (window.confirm(`Delete character profile “${c.name}”?`)) remove.mutate({ id: c.id }, { onSuccess: () => client.invalidateQueries({ queryKey: getListStudioCharactersQueryKey() }) }); }}><Trash2 size={15} /></IconButton></div></div><p>{c.description || 'No story notes yet.'}</p><div className="character-meta"><span>{c.visualStyle || 'Style not set'}</span><span>{c.voiceNotes ? 'Voice notes saved' : 'No voice notes'}</span></div></div><div className="character-detail"><span>APPEARANCE NOTES</span><p>{c.appearance || 'No appearance description saved.'}</p></div></article>)}</div> : <EmptyState icon={UsersRound} title="A character is more than a reference image." detail="Build a reusable written profile for appearance, personality, and voice." action={<Button onClick={() => setActive('new')}><Plus size={15} /> Create a character</Button>} />}</QueryState>
    {active && <CharacterDialog value={active === 'new' ? undefined : active} close={() => setActive(null)} />}
  </>;
}

function JobsPage() {
  const queryClient = useQueryClient(); const jobs = useListStudioJobs({}); const projects = useListStudioProjects(); const retry = useRetryStudioJob(); const cancel = useCancelStudioJob();
  const refresh = () => { jobs.refetch(); queryClient.invalidateQueries({ queryKey: getListStudioJobsQueryKey({}) }); queryClient.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); };
  return <><PageHeading eyebrow="PRODUCTION / QUEUE" title="The work behind the story." description="Jobs are shown only when the API has accepted them. Status, attempts, and progress come from the queue." action={<Button variant="soft" onClick={refresh}><RefreshCw size={15} /> Refresh queue</Button>} />
    <QueryState loading={jobs.isLoading || projects.isLoading} error={jobs.error || projects.error} retry={() => { jobs.refetch(); projects.refetch(); }}>{jobs.data?.length ? <div className="jobs-table">{jobs.data.map((job) => { const proj = projects.data?.find((p) => p.id === job.projectId); return <article className="queue-card" key={job.id} data-testid={`job-${job.id}`}><div className={`job-icon job-${job.status}`}><Sparkles size={17} /></div><div className="queue-info"><div className="queue-title"><h3>{job.type.replaceAll('_', ' ')}</h3><StatusTag status={job.status} /></div><b>{proj?.title || `Project ${job.projectId}`}</b><p>{job.message || 'No status detail returned by the engine.'}</p>{job.error && <p className="inline-error">{job.error}</p>}<div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div><div className="queue-meta"><span>{job.progress}% reported</span><span>Attempt {job.attempt} / {job.maxAttempts}</span><span>{new Date(job.updatedAt).toLocaleString()}</span></div></div><div className="queue-actions">{(job.status === 'failed' || job.status === 'cancelled') && <Button variant="soft" onClick={() => retry.mutate({ id: job.id }, { onSuccess: refresh })} disabled={retry.isPending}><RefreshCw size={14} /> Retry</Button>}{(job.status === 'queued' || job.status === 'running') && <Button variant="quiet" onClick={() => cancel.mutate({ id: job.id }, { onSuccess: refresh })} disabled={cancel.isPending}>Cancel</Button>}</div></article>; })}</div> : <EmptyState icon={Activity} title="Nothing in the queue." detail="Queued story and scene jobs will show their real server-reported progress here." />}</QueryState>
  </>;
}

function PublishingPage() {
  const status = useGetYouTubeStatus(); const analytics = useGetYouTubeAnalytics();
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const disconnect = async () => {
    if (!window.confirm('Disconnect YouTube and remove the saved encrypted refresh token?')) return;
    setConnectionError(null);
    try {
      const response = await fetch(`${basePath}/api/studio/youtube/connection`, { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `Request failed (${response.status}).`);
      await Promise.all([status.refetch(), analytics.refetch()]);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not disconnect the channel.');
    }
  };
  const callbackStatus = new URLSearchParams(window.location.search).get('youtube');
  const callbackMessage = callbackStatus === 'connected' ? 'YouTube confirmed the channel connection.' :
    callbackStatus && callbackStatus !== 'error' ? `YouTube connection was not completed (${callbackStatus.replaceAll('-', ' ')}).` : null;
  return <><PageHeading eyebrow="DISTRIBUTION / YOUTUBE" title="Publishing, without guesswork." description="Connection and analytics are read from your authorized channel. This studio never implies an upload that did not happen." />
    <QueryState loading={status.isLoading || analytics.isLoading} error={status.error || analytics.error} retry={() => { status.refetch(); analytics.refetch(); }}>
      <section className="youtube-connect"><div className="youtube-emblem"><Send size={22} /></div><div className="youtube-copy"><span className="eyebrow">CHANNEL CONNECTION</span><h2>{status.data?.connected ? status.data.channelTitle || 'YouTube channel connected' : 'Your channel is not connected.'}</h2><p>{status.data?.detail || 'The API has not reported YouTube OAuth status.'}</p></div><div className={`connection-state ${status.data?.connected ? 'connected' : ''}`}><i />{status.data?.connected ? 'CONNECTED' : status.data?.configured ? 'NOT CONNECTED' : 'NOT CONFIGURED'}</div>{status.data?.configured && !status.data.connected && <a className="button button-primary" href={`${basePath}/api/studio/youtube/connect`}>Connect channel <ArrowRight size={15} /></a>}{status.data?.connected && <Button variant="soft" onClick={disconnect}>Disconnect</Button>}</section>
      {callbackMessage && <p className={callbackStatus === 'connected' ? 'backup-message' : 'inline-error'} role="status">{callbackMessage}</p>}
      {connectionError && <p className="inline-error" role="alert">{connectionError}</p>}
      <section className="section-block analytics-section"><div className="section-heading"><div><span className="eyebrow">CHANNEL ANALYTICS</span><h2>Real channel numbers only.</h2></div><ShieldCheck size={18} /></div>{analytics.data?.available ? <div className="analytics-grid">{[{ label: 'Views', value: analytics.data.views?.toLocaleString() ?? '—' }, { label: 'Subscribers', value: analytics.data.subscribers?.toLocaleString() ?? '—' }, { label: 'Estimated revenue', value: analytics.data.estimatedRevenue === null ? '—' : `${analytics.data.currency || ''} ${analytics.data.estimatedRevenue}` }].map((m) => <div className="analytic-card" key={m.label}><span>{m.label}</span><b>{m.value}</b><small>Reported by YouTube API</small></div>)}</div> : <div className="analytics-unavailable"><CloudOff size={19} /><div><b>Analytics are unavailable</b><p>{analytics.data?.detail || 'No authorized YouTube analytics are currently available.'}</p></div></div>}</section>
      <div className="upload-truth"><div className="truth-icon"><ShieldCheck size={18} /></div><div><b>Uploads require explicit approval.</b><p>The available API does not expose a supported YouTube upload action here. Nothing has been uploaded, and no upload control is shown.</p></div></div>
    </QueryState>
  </>;
}

function SettingsPage() {
  const client = useQueryClient(); const engines = useGetStudioEngines(); const backup = useExportStudioBackup(); const restore = useRestoreStudioBackup(); const input = useRef<HTMLInputElement>(null); const [message, setMessage] = useState('');
  const downloadBackup = async () => { setMessage('Requesting a portable backup…'); const result = await backup.refetch(); if (result.data) { const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `bhai-studio-backup-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url); setMessage('Backup downloaded from the studio API.'); } else setMessage('Backup could not be exported. Check the API connection and try again.'); };
  const importBackup = async (file?: File) => { if (!file) return; try { const data = JSON.parse(await file.text()) as StudioBackup; if (data.formatVersion !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.scenes) || !Array.isArray(data.characters)) throw new Error('This file does not match the supported Studio Backup format.'); if (!window.confirm(`Restore ${data.projects.length} projects, ${data.scenes.length} scenes, and ${data.characters.length} characters? This sends the backup to the API.`)) return; restore.mutate({ data }, { onSuccess: (result) => { client.invalidateQueries({ queryKey: getGetStudioOverviewQueryKey() }); client.invalidateQueries({ queryKey: getListStudioProjectsQueryKey() }); client.invalidateQueries({ queryKey: getListStudioCharactersQueryKey() }); setMessage(`Restore complete: ${result.projects} projects, ${result.scenes} scenes, ${result.characters} characters.`); }, onError: () => setMessage('Restore failed. Existing studio records have not been replaced in this view.') }); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not read this backup file.'); } finally { if (input.current) input.current.value = ''; } };
  return <><PageHeading eyebrow="STUDIO / SETTINGS" title="Your setup, in plain sight." description="Check local engine availability and take your work with you in a portable studio backup." />
    <section className="settings-panel"><div className="section-heading"><div><span className="eyebrow">LOCAL GENERATION</span><h2>Engine health</h2></div><Button variant="soft" onClick={() => engines.refetch()}><RefreshCw size={14} /> Refresh</Button></div>
      <QueryState loading={engines.isLoading} error={engines.error} retry={() => engines.refetch()}>{engines.data?.length ? <div className="engine-list">{engines.data.map((engine) => <article className="engine-row" key={engine.id}><div className={`engine-indicator ${engine.available ? 'is-available' : ''}`}><Activity size={16} /></div><div className="engine-info"><b>{engine.name}</b><p>{engine.detail || 'No additional engine detail provided.'}</p></div><div className="engine-flags"><span>{engine.local ? 'LOCAL' : 'REMOTE'}</span><StatusTag status={engine.available ? 'available' : engine.configured ? 'configured' : 'unavailable'} /></div></article>)}</div> : <EmptyState icon={Activity} title="No engines reported." detail="Engine records appear here when the API can inspect the local generation setup." />}</QueryState>
      {engines.data?.some((e) => !e.available) && <div className="engine-blocker"><CircleAlert size={17} /><div><b>Generation is blocked until an engine is available.</b><p>Check each engine's API-provided detail above. This workspace does not simulate AI responses or queue success.</p></div></div>}
    </section>
    <section className="settings-panel backup-panel"><div className="backup-heading"><div className="backup-art"><ArrowDownToLine size={20} /></div><div><span className="eyebrow">PORTABLE WORK</span><h2>Take your story bible with you.</h2><p>Export and restore the Studio Backup file returned by the API. It includes projects, scenes, and characters.</p></div></div><div className="backup-actions"><Button onClick={downloadBackup} disabled={backup.isFetching}><ArrowDownToLine size={15} /> {backup.isFetching ? 'Preparing backup…' : 'Download backup'}</Button><Button variant="soft" onClick={() => input.current?.click()} disabled={restore.isPending}><Upload size={15} /> Choose backup to restore</Button><input ref={input} hidden type="file" accept="application/json,.json" onChange={(e) => importBackup(e.target.files?.[0])} /></div>{message && <p className={`backup-message ${restore.isError || backup.isError ? 'inline-error' : ''}`}>{message}</p>}{backup.isError && <p className="inline-error">The API could not export the backup: {String(backup.error)}</p>}</section>
  </>;
}

function NotFoundPage() { return <div className="not-found"><Brand /><span className="eyebrow">404 / LOST FRAME</span><h1>This scene isn't in the cut.</h1><p>The path may have changed, or the story may not exist.</p><Link className="button button-primary" href="/studio">Back to your studio <ArrowRight size={15} /></Link></div>; }

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk(); const queryClient = useQueryClient(); const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => { const unsubscribe = addListener(({ user }) => { const userId = user?.id ?? null; if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) queryClient.clear(); prevUserIdRef.current = userId; }); return unsubscribe; }, [addListener, queryClient]);
  return null;
}
function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={HomeRoute} /><Route path="/studio"><Protected><Dashboard /></Protected></Route>
    <Route path="/projects" component={() => <Protected><ProjectsPage /></Protected>} />
    <Route path="/projects/:id" component={() => <Protected><ProjectDetail /></Protected>} />
    <Route path="/characters"><Protected><CharactersPage /></Protected></Route>
    <Route path="/jobs"><Protected><JobsPage /></Protected></Route>
    <Route path="/publishing"><Protected><PublishingPage /></Protected></Route>
    <Route path="/settings"><Protected><SettingsPage /></Protected></Route>
    <Route component={NotFoundPage} />
  </Switch></RoutedErrorBoundary>;
}
function ClerkRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={appearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Pick up where your story left off.' } }, signUp: { start: { title: 'Make a place for your stories', subtitle: 'Your private production desk starts here.' } } }}
    routerPush={(to: string) => setLocation(stripBase(to))} routerReplace={(to: string) => setLocation(stripBase(to), { replace: true })}>
    <QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><Switch>
      <Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} />
      <Route><Router /></Route>
    </Switch></QueryClientProvider>
  </ClerkProvider>;
}
function App() { return <WouterRouter base={basePath}><ClerkRoutes /></WouterRouter>; }
export default App;
