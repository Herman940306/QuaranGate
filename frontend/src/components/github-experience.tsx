"use client";
import { useMemo, useState } from "react";
import { createGitHubClient, type PullView, type RepoSummary } from "../lib/client/github/client";
import { useOperationalRead } from "../lib/client/use-operational-read";
import { useWorkstationAction } from "../lib/client/workstation/use-action";
import { useIdentity } from "./identity-provider";
import { OperationalStateView } from "./operational-read";
import { Badge, Button, EmptyState, Input, MachineOutput, Panel, Select, Table, Textarea } from "./primitives";

function canMutate(identity: ReturnType<typeof useIdentity>) {
  return identity.integrated && identity.state.kind === "active" && identity.state.session.principal.status === "mapped";
}
export function GitHubExperience() {
  const client = useMemo(() => createGitHubClient(), []);
  const identity = useIdentity();
  const reposRead = useOperationalRead<RepoSummary[]>();
  const pullsRead = useOperationalRead<PullView[]>();
  const issuesRead = useOperationalRead<import("../lib/client/github/client").IssueView[]>();
  const filesRead = useOperationalRead<import("../lib/client/github/client").PullFile[]>();
  const reviewsRead = useOperationalRead<import("../lib/client/github/client").ReviewView[]>();
  const checksRead = useOperationalRead<import("../lib/client/github/client").StatusView>();
  const action = useWorkstationAction<unknown>();
  const [repository, setRepository] = useState("");
  const [pullNumber, setPullNumber] = useState("");
  const [ref, setRef] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reviewEvent, setReviewEvent] = useState<"COMMENT"|"APPROVE"|"REQUEST_CHANGES">("COMMENT");
  const [reviewBody, setReviewBody] = useState("");
  const [pushProject, setPushProject] = useState("");
  const [pushHead, setPushHead] = useState("");
  const [pushBranch, setPushBranch] = useState("");
  const [prHead, setPrHead] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [updateTitle, setUpdateTitle] = useState("");
  const [updateState, setUpdateState] = useState<""|"open"|"closed">("");

  const repos = reposRead.receipt?.data ?? [];
  const selected = repos.find(row => row.repository === repository);
  const number = /^\d+$/.test(pullNumber) ? Number(pullNumber) : 0;
  const mutationAllowed = canMutate(identity);

  function choose(repo: string) {
    setRepository(repo); setPullNumber(""); setRef(""); setConfirmation("");
    pullsRead.cancel(); issuesRead.cancel(); filesRead.cancel(); reviewsRead.cancel(); checksRead.cancel(); action.reset();
  }
  function reconcilePull() {
    if (!repository || !number) return Promise.resolve();
    return client.pull(repository, number).then(() => undefined);
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">QUARANHUB / TRUSTED REMOTE CONTROL</p><h1>GitHub</h1><p className="page-intro">Browse only repositories returned by trusted QuaranHUB installations. Remote write/review actions remain separately scoped, explicit and pessimistic. There is no merge, force-push, ref-delete or arbitrary-remote control.</p></div><Badge>GitHub App boundary</Badge></div>
    <div className="review-grid">
      <Panel title="Governed repositories">
        <p className="muted">Read availability grants no write or review authority. Repository discovery accepts no caller-supplied remote URL.</p>
        <Button busy={reposRead.pending} onClick={() => void reposRead.run(signal => client.repositories(signal))}>Read repositories</Button>
        {reposRead.state !== "available" && reposRead.state !== "not_connected" ? <OperationalStateView state={reposRead.state} correlationId={reposRead.correlationId} /> : null}
        {repos.length ? <><Table caption="Governed repositories" headings={["Repository","Owner","Private","Archived","Local project"]} rows={repos.slice(0,100).map((row,i)=>({id:String(i),cells:{Repository:row.repository,Owner:row.owner,Private:String(row.private),Archived:String(row.archived),"Local project":row.localProject??"UNKNOWN"}}))}/><Select id="github-repository" label="Repository workspace" value={repository} onChange={e=>choose(e.target.value)}><option value="">Select returned repository</option>{repos.map(row=><option key={row.repository} value={row.repository}>{row.repository}</option>)}</Select></> : reposRead.receipt ? <EmptyState title="No repositories returned">No trusted QuaranHUB repositories are visible.</EmptyState> : null}
      </Panel>
      <Panel title={selected ? selected.repository : "Repository workspace"}>
        {!selected ? <EmptyState title="Select a governed repository">Repository names come only from server discovery; no remote URL input is accepted.</EmptyState> : <>
          <p className="muted">Protected branches reported at discovery: {selected.protectedBranches.join(", ") || "None exposed"}.</p>
          <div className="cluster"><Button onClick={() => void pullsRead.run(signal => client.pulls(repository,"open",signal))}>Read pull requests</Button><Button onClick={() => void issuesRead.run(signal => client.issues(repository,"open",signal))}>Read issues</Button></div>
          {pullsRead.receipt ? <Table caption="Pull requests" headings={["Number","Title","State","Head","Base"]} rows={pullsRead.receipt.data.map(row=>({id:String(row.number),cells:{Number:String(row.number),Title:row.title,State:row.state,Head:row.headRef,Base:row.baseRef}}))}/> : null}
          {issuesRead.receipt ? <Table caption="Issues" headings={["Number","Title","State","Comments"]} rows={issuesRead.receipt.data.map(row=>({id:String(row.number),cells:{Number:String(row.number),Title:row.title,State:row.state,Comments:String(row.comments)}}))}/> : null}
          <Input id="github-pr-number" label="Pull request number" inputMode="numeric" value={pullNumber} onChange={e=>setPullNumber(e.target.value)} />
          <div className="cluster"><Button disabled={!number} onClick={() => void filesRead.run(signal => client.files(repository,number,signal))}>Read changed files</Button><Button disabled={!number} onClick={() => void reviewsRead.run(signal => client.reviews(repository,number,signal))}>Read reviews</Button></div>
          {filesRead.receipt ? <div>{filesRead.receipt.data.map(file=><Panel key={file.filename} title={file.filename}><p className="muted">{file.status} · +{file.additions} −{file.deletions} · {file.changes} changes</p>{file.patch ? <MachineOutput label="Bounded GitHub patch · untrusted text">{file.patch}</MachineOutput>:<p className="muted">No bounded patch text returned.</p>}</Panel>)}</div> : null}
          {reviewsRead.receipt ? <Table caption="Submitted reviews" headings={["ID","User","State"]} rows={reviewsRead.receipt.data.map(row=>({id:String(row.id),cells:{ID:String(row.id),User:row.user??"UNKNOWN",State:row.state}}))}/> : null}
          <Input id="github-ref" label="Branch or exact commit for statuses" value={ref} onChange={e=>setRef(e.target.value)} />
          <Button disabled={!ref.trim()} onClick={() => void checksRead.run(signal => client.checks(repository,ref,signal))}>Read commit statuses</Button>
          {checksRead.receipt ? <Table caption="Commit statuses" headings={["Context","State","Description"]} rows={checksRead.receipt.data.statuses.map((row,i)=>({id:String(i),cells:{Context:row.context,State:row.state,Description:row.description??""}}))}/> : null}
        </>}
      </Panel>
    </div>
    <Panel title="Remote actions">
      <p className="muted">Read access never grants remote mutation. Production controls stay disabled until an integrated active session supplies a mapped principal; the gateway independently enforces GitHub scopes and trusted account/project grants.</p>
      {!mutationAllowed ? <p className="muted">Product identity integration pending. Remote write and review requests cannot be sent.</p> : null}
      <div className="review-grid">
        <Panel title="Publish exact local HEAD">
          <Input id="github-push-project" label="Trusted logical project" value={pushProject} onChange={e=>setPushProject(e.target.value)} />
          <Input id="github-push-head" label="Expected HEAD (40-char SHA)" value={pushHead} maxLength={40} onChange={e=>setPushHead(e.target.value)} />
          <Input id="github-push-branch" label="Remote branch" value={pushBranch} onChange={e=>setPushBranch(e.target.value)} />
          <Input id="github-push-confirm" label="Type publish <project> <branch> to confirm" value={confirmation} onChange={e=>setConfirmation(e.target.value)} />
          <Button intent="destructive" emphasis="solid" disabled={!mutationAllowed || confirmation!==`publish ${pushProject} ${pushBranch}`} busy={action.pending} onClick={() => void action.run(()=>client.push(pushProject,pushHead,pushBranch))}>Publish exact HEAD</Button>
        </Panel>
        <Panel title="Create pull request">
          <Input id="github-pr-head" label="Head branch" value={prHead} onChange={e=>setPrHead(e.target.value)} />
          <Input id="github-pr-base" label="Base branch" value={prBase} onChange={e=>setPrBase(e.target.value)} />
          <Input id="github-pr-title" label="Title" value={prTitle} maxLength={256} onChange={e=>setPrTitle(e.target.value)} />
          <Textarea id="github-pr-body" label="Body" value={prBody} maxLength={65536} onChange={e=>setPrBody(e.target.value)} />
          <Input id="github-create-confirm" label={`Type create ${repository||"<repository>"} to confirm`} value={confirmation} onChange={e=>setConfirmation(e.target.value)} />
          <Button intent="attention" emphasis="solid" disabled={!mutationAllowed||!repository||confirmation!==`create ${repository}`} busy={action.pending} onClick={() => void action.run(()=>client.createPull(repository,{head:prHead,base:prBase,title:prTitle,body:prBody}))}>Create pull request</Button>
        </Panel>
        <Panel title="Update pull request">
          <Input id="github-update-title" label="New title (optional)" value={updateTitle} maxLength={256} onChange={e=>setUpdateTitle(e.target.value)} />
          <Select id="github-update-state" label="State change" value={updateState} onChange={e=>setUpdateState(e.target.value as ""|"open"|"closed")}><option value="">No state change</option><option value="open">Open</option><option value="closed">Close</option></Select>
          <Input id="github-update-confirm" label={`Type update ${number||"<number>"} to confirm`} value={confirmation} onChange={e=>setConfirmation(e.target.value)} />
          <Button intent="attention" disabled={!mutationAllowed||!repository||!number||(!updateTitle.trim()&&!updateState)||confirmation!==`update ${number}`} busy={action.pending} onClick={()=>void action.run(()=>client.updatePull(repository,number,{...(updateTitle.trim()?{title:updateTitle.trim()}:{}),...(updateState?{state:updateState}:{})}),reconcilePull)}>Update pull request</Button>
        </Panel>
        <Panel title="Submit pull request review">
          <Select id="github-review-event" label="Review event" value={reviewEvent} onChange={e=>{setReviewEvent(e.target.value as typeof reviewEvent);setConfirmation("");}}><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></Select>
          <Textarea id="github-review-body" label="Review body" value={reviewBody} maxLength={65536} onChange={e=>setReviewBody(e.target.value)} />
          <Input id="github-review-confirm" label={`Type review ${number||"<number>"} ${reviewEvent.toLowerCase()} to confirm`} value={confirmation} onChange={e=>setConfirmation(e.target.value)} />
          <Button intent={reviewEvent==="APPROVE"?"attention":"destructive"} emphasis="solid" disabled={!mutationAllowed||!repository||!number||confirmation!==`review ${number} ${reviewEvent.toLowerCase()}`} busy={action.pending} onClick={()=>void action.run(()=>client.reviewPull(repository,number,reviewEvent,reviewBody||undefined),reconcilePull)}>Submit review</Button>
        </Panel>
      </div>
      {action.receipt ? <p role="status">Server acknowledged the remote GitHub request. This acknowledgement does not imply merge or any capability beyond the exact returned operation.</p> : null}
      {action.failure ? <p role="alert">Remote outcome unverified or denied. Re-read GitHub state before retrying; no automatic retry occurs.</p> : null}
    </Panel>
  </>;
}
