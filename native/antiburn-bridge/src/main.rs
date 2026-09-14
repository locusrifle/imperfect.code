use antiburn_local::analysis::{analyze_sources_with, RawSource, SessionInput};
use antiburn_local::discovery::{Explorers, SessionSource};
use antiburn_local::model::AgentKind;
use anyhow::Result;
use std::time::{SystemTime, UNIX_EPOCH};

const ENGINE: &str = "antiburn-local-v0.7.1";
const ENGINE_SHA: &str = "c06456780a4e1cd6317168c79873092194d111bc";
const MAX_SESSIONS: usize = 24;
const DEFAULT_SINCE_SECS: i64 = 14 * 24 * 60 * 60;

fn analysis_agent(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Cursor => "cursor",
        AgentKind::Copilot => "copilot",
        AgentKind::Cline => "cline",
        AgentKind::OpenCode => "opencode",
        AgentKind::Kiro => "kiro",
        AgentKind::AmpCode => "amp-code",
        AgentKind::Antigravity => "antigravity",
        AgentKind::Windsurf => "windsurf",
        AgentKind::Pi => "pi",
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let since_secs = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_SINCE_SECS);
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let explorers = Explorers::DISK;
    let mut logs = Vec::new();
    for kind in AgentKind::ALL {
        logs.extend(explorers.get(kind).discover_recent(now, since_secs).await);
    }
    logs.sort_by_key(|log| std::cmp::Reverse(log.updated_at.unwrap_or(0)));
    logs.truncate(MAX_SESSIONS);

    let mut inputs = Vec::new();
    for log in &logs {
        let SessionSource::File(path) = &log.source else {
            continue;
        };
        let session_id = explorers
            .recover_session_id_from_path(&log.agent_type, path)
            .unwrap_or_else(|| {
                path.file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string())
            });
        inputs.push(SessionInput {
            agent: analysis_agent(log.agent_type).to_string(),
            session_id,
            source: RawSource::File(path.clone()),
            fork_parent_session_id: None,
        });
    }

    let summary = analyze_sources_with(inputs, false);
    let sessions: Vec<serde_json::Value> = summary
        .sessions
        .iter()
        .map(|session| {
            serde_json::json!({
                "agent": session.agent,
                "sessionId": session.session_id,
                "model": session.model,
                "tokensIn": session.tokens_in,
                "tokensOut": session.tokens_out,
                "peakContextTokens": session.peak_context_tokens,
                "contextWindow": session.context_window,
                "cacheRehydrationCount": session.cache_rehydration_count,
                "compactionCount": session.compaction_count,
                "cost": session.cost.as_ref().map(|cost| serde_json::json!({ "totalUsd": cost.total_usd })),
            })
        })
        .collect();
    let report = serde_json::json!({
        "engine": ENGINE,
        "engineSha": ENGINE_SHA,
        "sessionCount": summary.session_count,
        "tokensInTotal": summary.tokens_in_total,
        "tokensOutTotal": summary.tokens_out_total,
        "costTotalUsd": summary.cost_total_usd,
        "peakContextTokens": summary.peak_context_tokens,
        "compactionCount": summary.compaction_count,
        "cacheRehydrationCount": summary.cache_rehydration_count,
        "sessions": sessions,
    });
    serde_json::to_writer(std::io::stdout(), &report)?;
    Ok(())
}
