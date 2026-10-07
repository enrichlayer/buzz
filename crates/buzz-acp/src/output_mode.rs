/// Controls the detail level requested for user-visible agent messages.
#[derive(clap::ValueEnum, Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum AgentOutputMode {
    /// Preserve the historical visible harness output without extra guidance.
    #[default]
    Full,
    /// Ask the agent to publish concise progress and outcome summaries.
    Summary,
}

impl AgentOutputMode {
    pub(crate) const fn instructions(self) -> Option<&'static str> {
        match self {
            Self::Full => None,
            Self::Summary => Some(include_str!("output_mode_summary.md")),
        }
    }

    pub(crate) fn append_instructions(self, prompt: &str) -> String {
        match self.instructions() {
            Some(instructions) => {
                format!("{}\n\n{}", prompt.trim_end(), instructions.trim())
            }
            None => prompt.to_string(),
        }
    }

    /// Layer output guidance onto the standing prompt without changing the
    /// historical full-mode prompt bytes. When base prompts are disabled, the
    /// system prompt remains the only portable place shared by every runner.
    pub(crate) fn apply_to_prompts(
        self,
        system_prompt: Option<&str>,
        base_prompt: Option<String>,
    ) -> (Option<String>, Option<String>) {
        match (self, base_prompt) {
            (Self::Full, base_prompt) => (system_prompt.map(str::to_owned), base_prompt),
            (Self::Summary, Some(base_prompt)) => (
                system_prompt.map(str::to_owned),
                Some(self.append_instructions(&base_prompt)),
            ),
            (Self::Summary, None) => {
                let system_prompt = match system_prompt {
                    Some(prompt) => self.append_instructions(prompt),
                    None => include_str!("output_mode_summary.md").trim().to_owned(),
                };
                (Some(system_prompt), None)
            }
        }
    }
}

impl std::fmt::Display for AgentOutputMode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Full => "full",
            Self::Summary => "summary",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_preserves_prompt_bytes() {
        let prompt = "platform instructions\n";
        assert_eq!(AgentOutputMode::Full.append_instructions(prompt), prompt);
    }

    #[test]
    fn summary_keeps_questions_approvals_and_errors_visible() {
        let prompt = AgentOutputMode::Summary.append_instructions("base");
        assert!(prompt.contains("concise progress"));
        assert!(prompt.contains("evidence"));
        assert!(prompt.contains("questions, approval requests, and errors"));
    }

    #[test]
    fn summary_uses_system_prompt_when_base_prompt_is_disabled() {
        let (system, base) = AgentOutputMode::Summary.apply_to_prompts(Some("system"), None);
        assert!(system.unwrap().contains("concise progress"));
        assert_eq!(base, None);

        let (system, base) = AgentOutputMode::Summary.apply_to_prompts(None, None);
        assert!(system.unwrap().contains("concise progress"));
        assert_eq!(base, None);
    }

    #[test]
    fn full_preserves_both_prompt_layers() {
        let base = Some("base\n".to_string());
        assert_eq!(
            AgentOutputMode::Full.apply_to_prompts(Some("system\n"), base.clone()),
            (Some("system\n".to_string()), base)
        );
    }
}
