import ast
import hashlib
import logging
import math
import re
import unicodedata
from dataclasses import dataclass

import kuzu
from fastapi import HTTPException

from .models import SearchRequest


logger = logging.getLogger(__name__)


def check_revision(store, graph):
    try:
        revision = store.metadata(graph["id"])["revision"]
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        raise HTTPException(409, "The graph was deleted during search. Please select a graph again.") from exc
    if revision != graph["revision"]:
        raise HTTPException(409, "The graph changed during search. Please search again.")


def name_tokens(text):
    return set(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold()))


def name_similarity(tokens, words):
    """Weighted Dice: exact word matches first, then one-to-one substrings."""
    if not tokens or not words:
        return 0.0
    exact = tokens & words
    weight = float(len(exact))
    remaining_tokens, remaining_words = tokens - exact, words - exact
    partial = sorted(
        ((min(len(a), len(b)) / max(len(a), len(b)), a, b)
         for a in remaining_tokens for b in remaining_words if a in b or b in a),
        key=lambda item: (-item[0], item[1], item[2]),
    )
    for score, token, word in partial:
        if token in remaining_tokens and word in remaining_words:
            weight += score
            remaining_tokens.remove(token)
            remaining_words.remove(word)
    return 2 * weight / (len(tokens) + len(words))


def valid_vector(vector):
    if len(vector) != 384 or not all(math.isfinite(value) for value in vector) or not any(vector):
        raise ValueError("The embedding model must return finite, nonzero 384-dimensional vectors.")
    norm = math.hypot(*vector)
    if not math.isfinite(norm):
        raise ValueError("The embedding model returned a vector with an invalid magnitude.")
    # Unit vectors preserve cosine ranking and avoid overflow/underflow in FLOAT[384].
    return [value / norm for value in vector]


def search_graph(store, embeddings, graph_id: str, request: SearchRequest):
    with store.lock:
        graph = store.get(graph_id)
        hashes = {}
        if request.mode == "vector":
            hashes = {row["id"]: row["hash"] for row in store.query(
                "MATCH (n:Entity) WHERE n.graph_id=$graph AND n.embedding IS NOT NULL "
                "RETURN n.id AS id, n.embedding_hash AS hash", {"graph": graph_id}
            )}
    if request.mode == "cypher":
        return search_cypher(store, graph, request)

    types = {item["id"]: item["name"] for item in graph["node_types"]}
    type_id = str(request.node_type_id) if request.node_type_id else ""
    if type_id and type_id not in types:
        raise HTTPException(422, "The node type does not belong to this graph.")
    candidates = [node for node in graph["nodes"] if not type_id or node["type_id"] == type_id]
    scores, query_vector, indexed = {}, None, 0
    if candidates and request.mode == "vector":
        pending = []
        for node in candidates:
            # Version the input contract so old name/type/description vectors are never reused.
            text = node["name"]
            fingerprint = hashlib.sha256(f"node-name-v1\n{embeddings.model_name}\n{text}".encode()).hexdigest()
            if hashes.get(node["id"]) != fingerprint:
                pending.append((node["id"], text, fingerprint))
        try:
            vectors = [valid_vector(vector) for vector in embeddings.documents([item[1] for item in pending])] if pending else []
            if len(vectors) != len(pending):
                raise ValueError("The embedding model returned an unexpected number of vectors.")
            query_vector = valid_vector(embeddings.query(request.query))
        except Exception as exc:
            logger.exception("Local embedding model could not run")
            raise HTTPException(503, "The local embedding model could not load or run. On first use, allow internet access to download the model, then retry. Semantic and Cypher search are available without it.") from exc
        with store.lock:
            check_revision(store, graph)
            with store.transaction():
                for (node_id, _, fingerprint), vector in zip(pending, vectors, strict=True):
                    store.query("MATCH (n:Entity {id:$id}) WHERE n.graph_id=$graph SET n.embedding=$vector, n.embedding_hash=$hash", {"id": node_id, "graph": graph_id, "vector": vector, "hash": fingerprint})
            indexed = len(pending)
    elif request.mode == "semantic":
        tokens = name_tokens(request.query)
        for node in candidates:
            words = name_tokens(node["name"])
            score = name_similarity(tokens, words)
            if score > 0:
                scores[node["id"]] = score

    with store.lock:
        check_revision(store, graph)
        if query_vector is not None:
            rows = store.query(
                "MATCH (n:Entity) WHERE n.graph_id=$graph AND ($type='' OR n.type_id=$type) AND n.embedding IS NOT NULL "
                "RETURN n.id AS id, array_cosine_similarity(n.embedding, CAST($vector AS FLOAT[384])) AS score "
                "ORDER BY score DESC, n.id LIMIT $limit",
                {"graph": graph_id, "type": type_id, "vector": query_vector, "limit": request.limit},
            )
            if any(row["score"] is None or not math.isfinite(row["score"]) for row in rows):
                raise HTTPException(503, "Vector similarity could not be calculated. Check the configured embedding model and retry.")
            scores = {row["id"]: max(-1.0, min(1.0, row["score"])) for row in rows}
    nodes = {node["id"]: node for node in graph["nodes"]}
    relationship_types = {item["id"]: item["name"] for item in graph["relationship_types"]}
    hits = []
    for node_id, score in sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:request.limit]:
        connections = []
        for edge in graph["edges"]:
            if node_id in (edge["source_id"], edge["target_id"]):
                connections.append({**edge, "relationship": relationship_types[edge["type_id"]], "source_name": nodes[edge["source_id"]]["name"], "target_name": nodes[edge["target_id"]]["name"]})
        hit = {**nodes[node_id], "type_name": types[nodes[node_id]["type_id"]], "score": score, "connections": connections}
        if request.mode == "vector":
            hit["distance"] = 1.0 - score
        hits.append(hit)
    return {"results": hits, "mode": request.mode, "revision": graph["revision"], "indexed_nodes": indexed, "model": embeddings.model_name if request.mode == "vector" else None}


# This is an allowlisted compiler, not a keyword filter over executable user text.
# Only generated identifiers/operators and parameterized values reach Kuzu. Every
# bound node, edge, and relationship-type join gets an independent graph predicate.
_CYPHER_TOKEN = re.compile(
    r'''(?P<space>\s+)|(?P<string>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")'''
    r"|(?P<word>[A-Za-z_][A-Za-z_0-9]*)|(?P<number>\d+(?:\.\d+)?)"
    r"|(?P<symbol><>|!=|<=|>=|->|<-|[()\[\]{},:.*=<>;\-])"
)
_FORBIDDEN_CYPHER = {
    "CREATE", "MERGE", "SET", "DELETE", "DETACH", "REMOVE", "DROP", "ALTER",
    "COPY", "LOAD", "IMPORT", "EXPORT", "INSTALL", "ATTACH", "USE", "CALL",
    "BEGIN", "COMMIT", "ROLLBACK", "CHECKPOINT", "EXPLAIN", "PROFILE",
}


@dataclass
class CypherBinding:
    name: str
    kind: str
    sql: str


@dataclass
class CypherExpression:
    sql: str
    title: str
    variable: str | None = None
    property: str | None = None


class ScopedCypher:
    """Compile a single MATCH/WHERE/RETURN/ORDER BY/LIMIT read query."""

    def __init__(self, query, graph_id, limit):
        self.tokens = []
        position, depth = 0, 0
        while position < len(query):
            match = _CYPHER_TOKEN.match(query, position)
            if not match:
                raise HTTPException(400, f"Unsupported Cypher syntax at character {position + 1}. Comments and quoted identifiers are not supported.")
            kind, value = match.lastgroup, match.group()
            if kind == "word" and value.upper() in _FORBIDDEN_CYPHER:
                raise HTTPException(403, "Cypher search only permits read-only MATCH queries. Writes, procedures, and database commands are forbidden.")
            if kind == "symbol":
                if value in ("(", "[", "{"):
                    depth += 1
                elif value in (")", "]", "}"):
                    depth -= 1
                if depth > 16:
                    raise HTTPException(400, "Cypher expressions may nest at most 16 levels.")
            if kind != "space":
                self.tokens.append((kind, value))
            position = match.end()
        self.tokens.append(("end", ""))
        self.position = 0
        self.bindings = {}
        self.joins = []
        self.predicates = []
        self.params = {"graph": graph_id}
        self.limit = limit
        self.query_limit = None
        self.projections = []
        self.columns = []

    def accept(self, value):
        kind, current = self.tokens[self.position]
        if kind not in ("string", "end") and current.upper() == value:
            self.position += 1
            return True
        return False

    def expect(self, value):
        if not self.accept(value):
            self.error(f"Expected {value}")

    def error(self, message):
        current = self.tokens[self.position][1] or "end of query"
        raise HTTPException(400, f"{message}; found {current!r}. Supported clauses: MATCH, WHERE, RETURN, ORDER BY, LIMIT.")

    def identifier(self):
        kind, value = self.tokens[self.position]
        if kind != "word":
            self.error("Expected an identifier")
        self.position += 1
        return value

    def parameter(self, value):
        key = f"value{len(self.params)}"
        self.params[key] = value
        return f"${key}"

    def literal(self):
        kind, value = self.tokens[self.position]
        if kind == "string":
            try:
                result = ast.literal_eval(value)
            except (ValueError, SyntaxError) as exc:
                raise HTTPException(400, "Invalid quoted Cypher string. Escape quotes with a backslash.") from exc
        elif kind == "number":
            result = float(value) if "." in value else int(value)
            if abs(result) > 2**63 - 1 or not math.isfinite(result):
                raise HTTPException(400, "Cypher numeric literals must be finite and within the signed 64-bit range.")
        elif kind == "word" and value.upper() in ("TRUE", "FALSE", "NULL"):
            result = {"TRUE": True, "FALSE": False, "NULL": None}[value.upper()]
        else:
            self.error("Expected a string, number, boolean, or null literal")
        self.position += 1
        return CypherExpression(self.parameter(result), value)

    def property_expression(self, binding, prop, selection=False):
        actual = "id" if prop == "uuid" else prop
        allowed = {"id", "name", "description"} if binding.kind == "Entity" else {"name"}
        if actual not in allowed:
            aliases = {"uuid"} if binding.kind == "Entity" else set()
            raise HTTPException(422, f"Unsupported {binding.kind} property {prop!r}. Allowed: {', '.join(sorted(allowed | aliases))}.")
        selectable = {"id", "name"} if binding.kind == "Entity" else {"name"}
        if selection and actual not in selectable:
            raise HTTPException(422, "Cypher filters may use node names, node UUIDs, and relationship names only. Node descriptions can be returned, but not filtered.")
        source = f"{binding.sql}_type" if binding.kind == "Link" and actual == "name" else binding.sql
        return CypherExpression(f"{source}.{actual}", f"{binding.name}.{prop}", binding.name, actual)

    def bind(self, kind, closing):
        name = self.identifier() if self.tokens[self.position][0] == "word" else None
        if name and name.startswith("__"):
            raise HTTPException(422, "Cypher variables starting with '__' are reserved for anonymous patterns.")
        name = name or f"__{kind.lower()}{len(self.bindings)}"
        if self.accept(":"):
            label = self.identifier()
            if label != kind:
                raise HTTPException(422, f"Unsupported label {label!r}. Use :{kind}; graph-defined types are properties, not labels.")
        binding = self.bindings.get(name)
        if binding and binding.kind != kind:
            raise HTTPException(422, f"Variable {name!r} cannot refer to both a node and a relationship.")
        if binding is None:
            binding = CypherBinding(name, kind, f"v{len(self.bindings)}")
            self.bindings[name] = binding
            self.predicates.append(f"{binding.sql}.graph_id=$graph")
            if kind == "Link":
                self.joins.append(f"({binding.sql}_type:RelationshipType)")
                self.predicates.extend([
                    f"{binding.sql}_type.graph_id=$graph",
                    f"{binding.sql}.type_id={binding.sql}_type.id",
                ])
        if self.accept("{"):
            while True:
                prop = self.property_expression(binding, self.identifier(), selection=True)
                self.expect(":")
                self.predicates.append(f"{prop.sql}={self.literal().sql}")
                if not self.accept(","):
                    break
            self.expect("}")
        self.expect(closing)
        return f"{binding.sql}:{kind}"

    def pattern(self):
        self.expect("(")
        pattern = f"({self.bind('Entity', ')')})"
        while self.tokens[self.position][1] in ("-", "<-"):
            incoming = self.accept("<-")
            if not incoming:
                self.expect("-")
            self.expect("[")
            relationship = self.bind("Link", "]")
            if incoming:
                self.expect("-")
                left, right = "<-", "-"
            else:
                left, right = "-", "->" if self.accept("->") else "-"
                if right == "-":
                    self.expect("-")
            self.expect("(")
            pattern += f"{left}[{relationship}]{right}({self.bind('Entity', ')')})"
        return pattern

    def expression(self, scalar=False, selection=False):
        kind, value = self.tokens[self.position]
        if kind in ("string", "number") or value.upper() in ("TRUE", "FALSE", "NULL"):
            return self.literal()
        name = self.identifier()
        if self.accept("("):
            if name.lower() not in ("lower", "upper"):
                raise HTTPException(422, "Only lower() and upper() are supported in Cypher search expressions.")
            argument = self.expression(scalar=True, selection=selection)
            self.expect(")")
            return CypherExpression(f"{name.lower()}({argument.sql})", f"{name.lower()}({argument.title})")
        binding = self.bindings.get(name)
        if binding is None:
            raise HTTPException(422, f"Unknown Cypher variable {name!r}.")
        if self.accept("."):
            return self.property_expression(binding, self.identifier(), selection=selection)
        if scalar:
            raise HTTPException(422, "Use a supported property when comparing or sorting a node or relationship.")
        # Whole objects are resolved from the saved snapshot, never raw Kuzu internals.
        return CypherExpression(f"{binding.sql}.id", name, name)

    def condition(self):
        parts = [self.conjunction()]
        while self.accept("OR"):
            parts.append(self.conjunction())
        return "(" + " OR ".join(parts) + ")"

    def conjunction(self):
        parts = [self.predicate()]
        while self.accept("AND"):
            parts.append(self.predicate())
        return "(" + " AND ".join(parts) + ")"

    def predicate(self):
        negate = False
        while self.accept("NOT"):
            negate = not negate
        if self.accept("("):
            result = self.condition()
            self.expect(")")
        else:
            left = self.expression(scalar=True, selection=True).sql
            operator = self.tokens[self.position][1].upper()
            if operator in ("=", "<>", "!=", "<", "<=", ">", ">=", "CONTAINS", "STARTS", "ENDS"):
                self.position += 1
                if operator in ("STARTS", "ENDS"):
                    self.expect("WITH")
                    operator += " WITH"
                result = f"{left} {operator} {self.expression(scalar=True, selection=True).sql}"
            elif self.accept("IN"):
                self.expect("[")
                values = []
                if not self.accept("]"):
                    values.append(self.literal().sql)
                    while self.accept(","):
                        values.append(self.literal().sql)
                    self.expect("]")
                result = f"{left} IN [{', '.join(values)}]"
            elif self.accept("IS"):
                negate_null = self.accept("NOT")
                self.expect("NULL")
                result = f"{left} IS {'NOT ' if negate_null else ''}NULL"
            else:
                self.error("Expected a comparison operator")
        return f"NOT ({result})" if negate else f"({result})"

    def project(self, expression, title):
        if title in self.columns:
            raise HTTPException(422, f"Duplicate Cypher column {title!r}. Use AS to give columns unique names.")
        self.projections.append(expression)
        self.columns.append(title)

    def compile(self):
        self.expect("MATCH")
        patterns = [self.pattern()]
        while self.accept(","):
            patterns.append(self.pattern())
        if self.accept("WHERE"):
            self.predicates.append(self.condition())
        self.expect("RETURN")
        distinct = self.accept("DISTINCT")
        if self.accept("*"):
            for binding in self.bindings.values():
                if not binding.name.startswith("__"):
                    self.project(CypherExpression(f"{binding.sql}.id", binding.name, binding.name), binding.name)
            if not self.projections:
                raise HTTPException(422, "RETURN * requires a named node or relationship.")
        else:
            while True:
                expression = self.expression()
                title = self.identifier() if self.accept("AS") else expression.title
                self.project(expression, title)
                if not self.accept(","):
                    break

        ordering = []
        if self.accept("ORDER"):
            self.expect("BY")
            while True:
                token = self.tokens[self.position][1]
                if token in self.columns and self.tokens[self.position + 1][1] not in (".", "("):
                    self.position += 1
                    expression = f"column{self.columns.index(token)}"
                else:
                    expression = self.expression(scalar=True, selection=True).sql
                direction = "DESC" if self.accept("DESC") else "ASC"
                if direction == "ASC":
                    self.accept("ASC")
                ordering.append(f"{expression} {direction}")
                if not self.accept(","):
                    break
        if self.accept("LIMIT"):
            kind, value = self.tokens[self.position]
            if kind != "number" or not value.isdecimal():
                self.error("LIMIT must be a nonnegative integer")
            self.query_limit = int(value)
            self.limit = min(self.limit, self.query_limit)
            self.position += 1
        self.accept(";")
        if self.tokens[self.position][0] != "end":
            self.error("Only one read-only MATCH statement is supported")

        # Scalar projections still carry descriptions for all matched nodes.
        described = {expr.variable for expr in self.projections if expr.property in (None, "description")}
        for binding in self.bindings.values():
            if binding.kind == "Entity" and binding.name not in described:
                expression = self.property_expression(binding, "description")
                self.project(expression, expression.title)
        # Fetch one extra row to report truncation without changing a smaller
        # LIMIT explicitly supplied by the query author.
        self.params["limit"] = min(self.limit + 1, self.query_limit) if self.query_limit is not None else self.limit + 1
        projection = ", ".join(f"{expr.sql} AS column{index}" for index, expr in enumerate(self.projections))
        statement = (
            f"MATCH {', '.join(patterns + self.joins)} WHERE {' AND '.join(self.predicates)} "
            f"RETURN {'DISTINCT ' if distinct else ''}{projection}"
        )
        if ordering:
            statement += " ORDER BY " + ", ".join(ordering)
        return statement + " LIMIT $limit"


def search_cypher(store, graph, request):
    compiled = ScopedCypher(request.query, graph["id"], request.limit)
    statement = compiled.compile()
    with store.lock:
        check_revision(store, graph)
        try:
            # A separate connection keeps the timeout and read-only transaction local
            # to this request. The compiler is the primary graph-isolation boundary.
            with kuzu.Connection(store.db) as connection:
                connection.set_query_timeout(5000)
                connection.execute("BEGIN TRANSACTION READ ONLY").close()
                try:
                    result = connection.execute(statement, compiled.params)
                    try:
                        rows = []
                        while len(rows) < compiled.params["limit"] and result.has_next():
                            rows.append(result.get_next())
                    finally:
                        result.close()
                finally:
                    try:
                        connection.execute("ROLLBACK").close()
                    except Exception:
                        # Kuzu may abort a transaction automatically after a
                        # failed statement; preserve the useful query error.
                        pass
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("Cypher search could not run: %s", exc)
            if "interrupt" in str(exc).lower() or "timeout" in str(exc).lower():
                raise HTTPException(408, "Cypher search exceeded the 5-second time limit. Simplify the query or add filters.") from exc
            message = str(exc).splitlines()[0] if str(exc).strip() else "The database rejected the query."
            raise HTTPException(400, f"Cypher query could not run: {message}") from exc
        check_revision(store, graph)

    types = {item["id"]: item["name"] for item in graph["node_types"]}
    relationships = {item["id"]: item["name"] for item in graph["relationship_types"]}
    objects = {
        "Entity": {node["id"]: {**node, "type_name": types[node["type_id"]]} for node in graph["nodes"]},
        "Link": {edge["id"]: {**edge, "name": relationships[edge["type_id"]]} for edge in graph["edges"]},
    }
    truncated = len(rows) > compiled.limit
    rows = rows[:compiled.limit]
    for row in rows:
        for index, expression in enumerate(compiled.projections):
            if expression.variable and expression.property is None:
                row[index] = objects[compiled.bindings[expression.variable].kind][row[index]]
    return {"columns": compiled.columns, "rows": rows, "mode": "cypher", "revision": graph["revision"], "indexed_nodes": 0, "model": None, "row_limit": compiled.limit, "truncated": truncated}
