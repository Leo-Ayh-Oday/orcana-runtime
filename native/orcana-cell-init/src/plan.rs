//! CellPlan：结构 + 极简 JSON 解析（纯 std）+ 校验（schema/digest/授权）。

use std::collections::HashMap;

#[derive(Debug)]
pub enum PlanError {
    Schema(String),
    Io(String),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Schema(s) => write!(f, "schema: {s}"),
            PlanError::Io(s) => write!(f, "io: {s}"),
        }
    }
}

impl std::error::Error for PlanError {}

#[derive(Debug, Clone)]
pub struct ExecSpec {
    pub path: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct Rlimits {
    pub as_bytes: Option<u64>,
    pub nofile: Option<u64>,
    pub nproc: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct LandlockSpec {
    pub read_paths: Vec<String>,
    pub write_paths: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SeccompSpec {
    pub allow_syscalls: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CellPlan {
    pub schema_version: String,
    pub exec: ExecSpec,
    pub cwd: String,
    pub rlimits: Rlimits,
    pub no_new_privs: bool,
    pub landlock: LandlockSpec,
    pub seccomp: SeccompSpec,
}

/// 极简 JSON 值（递归下降解析器 —— 只支持 plan 需要的最小形状）。
#[derive(Debug, Clone)]
pub enum Json {
    Object(HashMap<String, Json>),
    Array(Vec<Json>),
    String(String),
    Number(f64),
    Bool(bool),
    Null,
}

pub struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

/// m2（LR2-4 审核）：最大嵌套深度（防递归下降栈溢出）。
const MAX_DEPTH: usize = 64;

impl<'a> Parser<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Parser { bytes, pos: 0, depth: 0 }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && (self.bytes[self.pos] as char).is_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, b: u8) -> Result<(), PlanError> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Ok(())
        } else {
            Err(PlanError::Schema(format!(
                "expected '{}' at {}",
                b as char, self.pos
            )))
        }
    }

    pub fn parse_value(&mut self) -> Result<Json, PlanError> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => {
                self.depth += 1;
                if self.depth > MAX_DEPTH {
                    return Err(PlanError::Schema("max nesting depth exceeded".into()));
                }
                self.pos += 1;
                let mut obj = HashMap::new();
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Ok(Json::Object(obj));
                }
                loop {
                    self.skip_ws();
                    let key = self.parse_string()?;
                    self.skip_ws();
                    self.expect(b':')?;
                    let value = self.parse_value()?;
                    obj.insert(key, value);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b'}') => {
                            self.pos += 1;
                            break;
                        }
                        _ => return Err(PlanError::Schema("expected , or }".into())),
                    }
                }
                self.depth -= 1;
                Ok(Json::Object(obj))
            }
            Some(b'[') => {
                self.depth += 1;
                if self.depth > MAX_DEPTH {
                    return Err(PlanError::Schema("max nesting depth exceeded".into()));
                }
                self.pos += 1;
                let mut arr = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Ok(Json::Array(arr));
                }
                loop {
                    let v = self.parse_value()?;
                    arr.push(v);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b']') => {
                            self.pos += 1;
                            break;
                        }
                        _ => return Err(PlanError::Schema("expected , or ]".into())),
                    }
                }
                self.depth -= 1;
                Ok(Json::Array(arr))
            }
            Some(b'"') => Ok(Json::String(self.parse_string()?)),
            Some(b't') => {
                if self.bytes[self.pos..].starts_with(b"true") {
                    self.pos += 4;
                    Ok(Json::Bool(true))
                } else {
                    Err(PlanError::Schema("bad literal".into()))
                }
            }
            Some(b'f') => {
                if self.bytes[self.pos..].starts_with(b"false") {
                    self.pos += 5;
                    Ok(Json::Bool(false))
                } else {
                    Err(PlanError::Schema("bad literal".into()))
                }
            }
            Some(b'n') => {
                if self.bytes[self.pos..].starts_with(b"null") {
                    self.pos += 4;
                    Ok(Json::Null)
                } else {
                    Err(PlanError::Schema("bad literal".into()))
                }
            }
            _ => {
                // m1（LR2-4 审核）：严格无符号整数（plan 的数值字段都是
                // u64 —— 小数/负数/超大值会导致 rlimit 饱和/失效）。
                let start = self.pos;
                while self.pos < self.bytes.len() && (self.bytes[self.pos] as char).is_ascii_digit() {
                    self.pos += 1;
                }
                if self.pos == start {
                    return Err(PlanError::Schema("expected number".into()));
                }
                let s = std::str::from_utf8(&self.bytes[start..self.pos])
                    .map_err(|_| PlanError::Schema("bad number".into()))?;
                let n = s
                    .parse::<u64>()
                    .map_err(|_| PlanError::Schema(format!("invalid unsigned integer: {s}")))?;
                Ok(Json::Number(n as f64))
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, PlanError> {
        self.expect(b'"')?;
        let start = self.pos;
        while self.pos < self.bytes.len() && self.bytes[self.pos] != b'"' {
            // M8（LR2-4 审核）：不支持转义就**拒绝**（遇到 \ 报错）——
            // 静默腐蚀合法 JSON（\n → 字面 b\nc）会产生错误路径/env 值。
            if self.bytes[self.pos] == b'\\' {
                return Err(PlanError::Schema("escapes unsupported (rejected, not corrupted)".into()));
            }
            self.pos += 1;
        }
        let s = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| PlanError::Schema("bad string".into()))?
            .to_string();
        self.expect(b'"')?;
        Ok(s)
    }
}

fn as_object(v: &Json) -> Option<&HashMap<String, Json>> {
    match v {
        Json::Object(o) => Some(o),
        _ => None,
    }
}

fn as_string(v: &Json) -> Option<&String> {
    match v {
        Json::String(s) => Some(s),
        _ => None,
    }
}

fn as_array(v: &Json) -> Option<&Vec<Json>> {
    match v {
        Json::Array(a) => Some(a),
        _ => None,
    }
}

fn as_bool(v: &Json) -> Option<bool> {
    match v {
        Json::Bool(b) => Some(*b),
        _ => None,
    }
}

fn as_u64(v: &Json) -> Option<u64> {
    match v {
        Json::Number(n) => Some(*n as u64),
        _ => None,
    }
}

fn str_array(v: &Json) -> Vec<String> {
    match as_array(v) {
        Some(arr) => arr
            .iter()
            .filter_map(|e| as_string(e).cloned())
            .collect(),
        None => Vec::new(),
    }
}

/// 解析并校验 CellPlan（schema/digest/授权）。
pub fn parse_plan(text: &str) -> Result<CellPlan, PlanError> {
    let mut parser = Parser::new(text.as_bytes());
    let root = parser.parse_value()?;
    // m3：根值后必须只有空白（尾随垃圾拒绝 —— 此前 `{...}xyz` 被接受）。
    parser.skip_ws();
    if parser.pos < text.len() {
        return Err(PlanError::Schema("trailing garbage after JSON root".into()));
    }
    let obj = as_object(&root).ok_or_else(|| PlanError::Schema("plan root must be object".into()))?;

    // schemaVersion 校验
    let schema_version = obj
        .get("schemaVersion")
        .and_then(as_string)
        .cloned()
        .ok_or_else(|| PlanError::Schema("missing schemaVersion".into()))?;
    if schema_version != "1.0" {
        return Err(PlanError::Schema(format!(
            "unsupported schemaVersion: {schema_version}"
        )));
    }

    // exec：path/args/env 必须完整（授权面 —— 缺字段拒绝）
    let exec_obj = obj
        .get("exec")
        .and_then(as_object)
        .ok_or_else(|| PlanError::Schema("missing exec".into()))?;
    let path = exec_obj
        .get("path")
        .and_then(as_string)
        .cloned()
        .ok_or_else(|| PlanError::Schema("exec.path required".into()))?;
    if path.is_empty() {
        return Err(PlanError::Schema("exec.path must not be empty".into()));
    }
    let args = exec_obj
        .get("args")
        .map(str_array)
        .ok_or_else(|| PlanError::Schema("exec.args required".into()))?;
    let env: HashMap<String, String> = match exec_obj.get("env") {
        Some(Json::Object(o)) => o
            .iter()
            .filter_map(|(k, v)| as_string(v).map(|s| (k.clone(), s.clone())))
            .collect(),
        _ => HashMap::new(),
    };

    let cwd = obj
        .get("cwd")
        .and_then(as_string)
        .cloned()
        .ok_or_else(|| PlanError::Schema("missing cwd".into()))?;

    let rlimits = match obj.get("rlimits") {
        Some(Json::Object(o)) => Rlimits {
            as_bytes: o.get("as").and_then(as_u64),
            nofile: o.get("nofile").and_then(as_u64),
            nproc: o.get("nproc").and_then(as_u64),
        },
        _ => Rlimits::default(),
    };

    let no_new_privs = obj.get("noNewPrivs").and_then(as_bool).unwrap_or(false);

    let landlock = match obj.get("landlock") {
        Some(Json::Object(o)) => LandlockSpec {
            read_paths: o.get("readPaths").map(str_array).unwrap_or_default(),
            write_paths: o.get("writePaths").map(str_array).unwrap_or_default(),
        },
        _ => LandlockSpec::default(),
    };

    let seccomp = match obj.get("seccomp") {
        Some(Json::Object(o)) => SeccompSpec {
            allow_syscalls: o
                .get("allowSyscalls")
                .map(str_array)
                .unwrap_or_default(),
        },
        _ => SeccompSpec::default(),
    };

    Ok(CellPlan {
        schema_version,
        exec: ExecSpec { path, args, env },
        cwd,
        rlimits,
        no_new_privs,
        landlock,
        seccomp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_plan() {
        let plan = parse_plan(
            r#"{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":["/bin/true"],"env":{"A":"1"}},"cwd":"/workspace","rlimits":{"as":100,"nofile":64},"noNewPrivs":true}"#,
        )
        .unwrap();
        assert_eq!(plan.exec.path, "/bin/true");
        assert_eq!(plan.cwd, "/workspace");
        assert_eq!(plan.rlimits.as_bytes, Some(100));
        assert_eq!(plan.exec.env.get("A").map(|s| s.as_str()), Some("1"));
        assert!(plan.no_new_privs);
    }

    #[test]
    fn rejects_bad_schema() {
        assert!(parse_plan(r#"{"schemaVersion":"2.0"}"#).is_err());
        assert!(parse_plan(r#"{"schemaVersion":"1.0","exec":{}}"#).is_err());
        assert!(parse_plan(r#"not json"#).is_err());
        assert!(parse_plan(r#"{"schemaVersion":"1.0","exec":{"path":"","args":[]},"cwd":"/x"}"#).is_err());
    }

    #[test]
    fn rejects_escapes_instead_of_corrupting() {
        // M8：\n 等转义 → 拒绝（不腐蚀成字面量）
        assert!(parse_plan(r#"{"schemaVersion":"1.0","exec":{"path":"a\nb","args":[],"env":{}},"cwd":"/"}"#).is_err());
    }

    #[test]
    fn rejects_fractional_or_negative_numbers() {
        // m1：小数/负数 → 拒绝（rlimit 饱和会 SIGSEGV/fail-open）
        assert!(parse_plan(r#"{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":[],"env":{}},"cwd":"/","rlimits":{"as":0.5}}"#).is_err());
        assert!(parse_plan(r#"{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":[],"env":{}},"cwd":"/","rlimits":{"as":-1}}"#).is_err());
    }

    #[test]
    fn rejects_deep_nesting() {
        // m2：64 层上限（100k 层曾栈溢出 exit 134）
        let deep = format!(r#"{{"schemaVersion":"1.0","exec":{{"path":"/bin/true","args":{},"env":{{}}}},"cwd":"/"}}"#, "[".repeat(100) + "0" + &"]".repeat(100));
        assert!(parse_plan(&deep).is_err());
    }

    #[test]
    fn rejects_trailing_garbage() {
        // m3：根值后残留 → 拒绝（此前 `{...}xyz` 被接受 exit 0）
        let good = r#"{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":[],"env":{}},"cwd":"/"}"#;
        assert!(parse_plan(good).is_ok());
        assert!(parse_plan(&format!("{good} xyz")).is_err());
    }

    #[test]
    fn key_order_irrelevant() {
        let a = parse_plan(
            r#"{"schemaVersion":"1.0","exec":{"path":"/bin/true","args":[],"env":{}},"cwd":"/x"}"#,
        )
        .unwrap();
        let b = parse_plan(
            r#"{"cwd":"/x","exec":{"env":{},"args":[],"path":"/bin/true"},"schemaVersion":"1.0"}"#,
        )
        .unwrap();
        assert_eq!(a.exec.path, b.exec.path);
    }
}
