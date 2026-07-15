use std::process::{Command, Output};

fn run_cli(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cubic-rs"))
        .args(arguments)
        .output()
        .expect("run cubic-rs")
}

fn assert_parse_help(arguments: &[&str], expect_error: bool, markers: &[&str]) {
    let output = run_cli(arguments);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());

    let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr");
    assert!(
        !stderr.contains("cubic-rs.exe"),
        "help should use the stable executable name:\n{stderr}"
    );
    assert_eq!(
        stderr.contains("error:"),
        expect_error,
        "unexpected parse-error state:\n{stderr}"
    );
    for marker in markers {
        assert!(
            stderr.contains(marker),
            "missing help marker {marker:?}:\n{stderr}"
        );
    }
}

#[test]
fn parse_errors_show_full_relevant_help() {
    assert_parse_help(
        &[],
        false,
        &["Manage HoloCubic DevTools", "Commands:", "device"],
    );
    assert_parse_help(
        &["unknown-command"],
        true,
        &["Manage HoloCubic DevTools", "Commands:", "device"],
    );
    assert_parse_help(
        &["stat"],
        true,
        &[
            "Show remote file or directory metadata",
            "Usage:",
            "<REMOTE>",
        ],
    );
    assert_parse_help(
        &["device"],
        false,
        &["Manage saved devices", "Commands:", "add"],
    );
}
