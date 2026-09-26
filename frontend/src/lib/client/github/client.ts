import { OperationalError } from "../../operational/state";
import { createMutator, createReader, type Transport } from "../../operational/transport";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationalError("unknown");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 65536): string {
  if (typeof value !== "string" || value.length > max || [...value].some(c => c.charCodeAt(0) === 0)) throw new OperationalError("unknown");
  return value;
}
function nonEmpty(value: string, max = 256): string {
  const v = text(value, max);
  if (!v.trim()) throw new OperationalError("unknown");
  return v;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new OperationalError("unknown"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new OperationalError("unknown"); return value; }
function positive(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new OperationalError("unknown"); return value; }
function list<T>(value: unknown, parse: (v: unknown) => T, max=100): T[] { if (!Array.isArray(value) || value.length > max) throw new OperationalError("unknown"); return value.map(parse); }
function optText(value: unknown, max=65536): string | undefined { return value === undefined ? undefined : text(value,max); }
function repoKey(value: string): string { if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value)) throw new OperationalError("unknown"); return value; }
function branch(value: string): string { if (!value || value.length > 255 || [..."~^:?*[\\"].some(char => value.includes(char)) || /\s/.test(value) || value.includes("..") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".lock")) throw new OperationalError("unknown"); return value; }
function sha(value: string): string { if (!/^[0-9a-f]{40}$/.test(value)) throw new OperationalError("unknown"); return value; }
function state(value: string): "open"|"closed"|"all" { if (!["open","closed","all"].includes(value)) throw new OperationalError("unknown"); return value as "open"|"closed"|"all"; }

export interface RepoSummary { repository:string; owner:string; repo:string; private:boolean; archived:boolean; localProject?:string; protectedBranches:string[] }
export interface RepoDetail { repository:string; localProject?:string; fullName:string; defaultBranch:string; private:boolean; archived:boolean; disabled:boolean; pushedAt?:string }
export interface BranchView { name:string; sha:string; protected:boolean }
export interface CommitView { sha:string; message:string; authorName?:string; authoredAt?:string }
export interface PullView { number:number; title:string; state:string; draft:boolean; headRef:string; baseRef:string; author?:string; updatedAt?:string }
export interface PullFile { filename:string; status:string; additions:number; deletions:number; changes:number; patch?:string }
export interface IssueView { number:number; title:string; state:string; author?:string; labels:string[]; comments:number; updatedAt?:string; body?:string; locked?:boolean }
export interface CommentView { id:number; author?:string; body:string; createdAt?:string; updatedAt?:string; path?:string; line?:number; side?:string; commitId?:string }
export interface ReviewView { id:number; user?:string; state:string; body?:string; submittedAt?:string; commitId?:string }
export interface StatusView { ref:string; statuses:{context:string;state:string;description?:string}[]; checkRuns:{name:string;status:string;conclusion?:string}[] }
export interface PushReceipt { project:string; remoteBranch:string; sha:string }
export interface ReviewReceipt { id:number; state:string }

const repoSummary=(v:unknown):RepoSummary=>{const r=record(v);const repository=repoKey(nonEmpty(r.repository as string));const inferredRepo=repository.slice(repository.indexOf("/")+1);return{repository,owner:nonEmpty(r.owner as string),repo:r.repo===undefined?inferredRepo:nonEmpty(r.repo as string),private:bool(r.private),archived:bool(r.archived),...(r.localProject===undefined?{}:{localProject:nonEmpty(r.localProject as string,64)}),protectedBranches:r.protectedBranches===undefined?[]:list(r.protectedBranches,x=>branch(nonEmpty(x as string)),100)}};
const repoDetail=(v:Record<string,unknown>):RepoDetail=>({repository:repoKey(nonEmpty(v.repository as string)),...(v.localProject===undefined?{}:{localProject:nonEmpty(v.localProject as string,64)}),fullName:nonEmpty(v.fullName as string),defaultBranch:branch(nonEmpty(v.defaultBranch as string)),private:bool(v.private),archived:bool(v.archived),disabled:bool(v.disabled),pushedAt:optText(v.pushedAt,64)});
const branchView=(v:unknown):BranchView=>{const r=record(v);return{name:branch(nonEmpty(r.name as string)),sha:sha(nonEmpty(r.sha as string,40)),protected:bool(r.protected)}};
const pull=(v:unknown):PullView=>{const r=record(v);return{number:positive(integer(r.number)),title:text(r.title,256),state:text(r.state,64),draft:bool(r.draft),headRef:branch(nonEmpty(r.headRef as string)),baseRef:branch(nonEmpty(r.baseRef as string)),author:optText(r.author,256),updatedAt:optText(r.updatedAt,64)}};
const pullFile=(v:unknown):PullFile=>{const r=record(v);return{filename:text(r.filename,512),status:text(r.status,64),additions:integer(r.additions),deletions:integer(r.deletions),changes:integer(r.changes),patch:optText(r.patch,262144)}};
const issue=(v:unknown):IssueView=>{const r=record(v);return{number:positive(integer(r.number)),title:text(r.title,256),state:text(r.state,64),author:optText(r.author),labels:list(r.labels,x=>text(x,128),100),comments:integer(r.comments),updatedAt:optText(r.updatedAt,64),body:optText(r.body,65536),locked:r.locked===undefined?undefined:bool(r.locked)}};
const comment=(v:unknown):CommentView=>{const r=record(v);return{id:integer(r.id),author:optText(r.author),body:text(r.body,65536),createdAt:optText(r.createdAt,64),updatedAt:optText(r.updatedAt,64),path:optText(r.path,512),line:r.line===undefined?undefined:integer(r.line),side:optText(r.side,64),commitId:optText(r.commitId,64)}};
const review=(v:unknown):ReviewView=>{const r=record(v);return{id:integer(r.id),user:optText(r.user),state:text(r.state,64),body:optText(r.body,65536),submittedAt:optText(r.submittedAt,64),commitId:optText(r.commitId,64)}};

export function createGitHubClient(transport?: Transport) {
  const read=createReader(transport); const mutate=createMutator(transport);
  return {
    repositories:(signal?:AbortSignal)=>read("github_repositories",{},v=>list(v.repositories,repoSummary,10000),signal),
    repository:(repository:string,signal?:AbortSignal)=>read("github_repository",{repository:repoKey(repository)},repoDetail,signal),
    branches:(repository:string,signal?:AbortSignal)=>read("github_branches",{repository:repoKey(repository),maxItems:100},v=>list(v.branches,branchView,100),signal),
    commits:(repository:string,ref:string,signal?:AbortSignal)=>read("github_commits",{repository:repoKey(repository),ref:branch(ref),maxItems:50},v=>list(v.commits,x=>{const r=record(x);return{sha:sha(nonEmpty(r.sha as string,40)),message:text(r.message,4096),authorName:optText(r.authorName),authoredAt:optText(r.authoredAt,64)}}),signal),
    pulls:(repository:string,s:"open"|"closed"|"all"="open",signal?:AbortSignal)=>read("github_pull_requests",{repository:repoKey(repository),state:state(s),maxItems:100},v=>list(v.pulls,pull,100),signal),
    pull:(repository:string,number:number,signal?:AbortSignal)=>read("github_pull_request",{repository:repoKey(repository),number:positive(number)},v=>pull(v),signal),
    files:(repository:string,number:number,signal?:AbortSignal)=>read("github_pull_request_files",{repository:repoKey(repository),number:positive(number),maxItems:100},v=>list(v.files,pullFile,100),signal),
    issues:(repository:string,s:"open"|"closed"|"all"="open",signal?:AbortSignal)=>read("github_issues",{repository:repoKey(repository),state:state(s),maxItems:100},v=>list(v.issues,issue,100),signal),
    issue:(repository:string,number:number,signal?:AbortSignal)=>read("github_issue",{repository:repoKey(repository),number:positive(number)},v=>issue(v),signal),
    issueComments:(repository:string,number:number,signal?:AbortSignal)=>read("github_issue_comments",{repository:repoKey(repository),number:positive(number),maxItems:100},v=>list(v.comments,comment,100),signal),
    reviews:(repository:string,number:number,signal?:AbortSignal)=>read("github_pull_request_reviews",{repository:repoKey(repository),number:positive(number),maxItems:100},v=>list(v.reviews,review,100),signal),
    reviewComments:(repository:string,number:number,signal?:AbortSignal)=>read("github_pull_request_review_comments",{repository:repoKey(repository),number:positive(number),maxItems:100},v=>list(v.comments,comment,100),signal),
    checks:(repository:string,ref:string,signal?:AbortSignal)=>read("github_checks",{repository:repoKey(repository),ref:branch(ref)},v=>({ref:text(v.ref,256),checkRuns:list(v.checkRuns,x=>{const r=record(x);return{name:text(r.name,256),status:text(r.status,64),conclusion:optText(r.conclusion,64)}},100),statuses:list(v.statuses,x=>{const r=record(x);return{context:text(r.context,256),state:text(r.state,64),description:optText(r.description,1024)}},100)}),signal),
    push:(project:string,expectedHead:string,remoteBranch:string,signal?:AbortSignal)=>mutate("github_push_branch",{project:nonEmpty(project,64),expectedHead:sha(expectedHead),remoteBranch:branch(remoteBranch)},v=>({project:nonEmpty(v.project as string,64),remoteBranch:branch(nonEmpty(v.remoteBranch as string)),sha:sha(nonEmpty(v.sha as string,40))}),signal),
    createPull:(repository:string,input:{head:string;base:string;title:string;body?:string;draft?:boolean},signal?:AbortSignal)=>mutate("github_pull_request_create",{repository:repoKey(repository),head:branch(input.head),base:branch(input.base),title:nonEmpty(input.title,256),...(input.body===undefined?{}:{body:text(input.body,65536)}),...(input.draft===undefined?{}:{draft:input.draft})},v=>pull(v),signal),
    updatePull:(repository:string,number:number,input:{title?:string;body?:string;state?:"open"|"closed"},signal?:AbortSignal)=>{if(input.title===undefined&&input.body===undefined&&input.state===undefined)throw new OperationalError("unknown");return mutate("github_pull_request_update",{repository:repoKey(repository),number:positive(number),...(input.title===undefined?{}:{title:nonEmpty(input.title,256)}),...(input.body===undefined?{}:{body:text(input.body,65536)}),...(input.state===undefined?{}:{state:input.state})},v=>pull(v),signal)},
    reviewPull:(repository:string,number:number,event:"COMMENT"|"APPROVE"|"REQUEST_CHANGES",body?:string,signal?:AbortSignal)=>mutate("github_pull_request_review",{repository:repoKey(repository),number:positive(number),event,...(body===undefined?{}:{body:text(body,65536)})},v=>({id:integer(v.id),state:text(v.state,64)}),signal),
  };
}
export type GitHubClient=ReturnType<typeof createGitHubClient>;
