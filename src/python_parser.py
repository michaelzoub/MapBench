import ast
import builtins
import copy
import json
import os
import sys


GENERATED_HEADER = "# @project-outline generated"
BUILTIN_NAMES = set(dir(builtins))
FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
SENSITIVE_NAME_PARTS = ("credential", "password", "secret", "token", "api_key", "private_key")
TRIVIAL_LITERAL_METHODS = {
    "append", "capitalize", "casefold", "clear", "copy", "count", "decode", "encode", "endswith",
    "extend", "format", "index", "insert", "isalnum", "isalpha", "isdigit", "islower", "isspace",
    "isupper", "join", "lower", "lstrip", "partition", "pop", "remove", "replace", "reverse",
    "rpartition", "rsplit", "rstrip", "sort", "split", "splitlines", "startswith", "strip", "swapcase",
    "title", "translate", "upper", "zfill",
}


def dotted_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_name(node.value)
        return parent + "." + node.attr if parent else None
    return None


def tail_name(node):
    name = dotted_name(node)
    return name.rsplit(".", 1)[-1] if name else None


def is_sensitive_name(name):
    lowered = name.lower()
    return any(part in lowered for part in SENSITIVE_NAME_PARTS)


def assignment_names(node):
    targets = [node.target] if isinstance(node, ast.AnnAssign) else node.targets
    return [target.id for target in targets if isinstance(target, ast.Name)]


def is_overload(node):
    return any(tail_name(decorator) == "overload" for decorator in node.decorator_list)


def module_names(relative_path):
    without_extension = relative_path[:-3]
    parts = without_extension.replace(os.sep, "/").split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    names = set()
    if parts:
        names.add(".".join(parts))
        if parts[0] in ("src", "lib", "python") and len(parts) > 1:
            names.add(".".join(parts[1:]))
    return sorted(name for name in names if name)


class Repository:
    def __init__(self, root, relative_files):
        self.root = root
        self.relative_files = sorted(relative_files)
        self.trees = {}
        self.modules_by_file = {}
        self.file_by_module = {}
        for relative in self.relative_files:
            absolute = os.path.join(root, relative)
            with open(absolute, "r", encoding="utf-8") as source_file:
                source = source_file.read()
            try:
                self.trees[relative] = ast.parse(source, filename=relative, type_comments=True)
            except SyntaxError as error:
                location = "%s:%s" % (relative, error.lineno or 1)
                raise ValueError("%s: %s" % (location, error.msg))
            names = module_names(relative)
            self.modules_by_file[relative] = names
            for name in names:
                self.file_by_module[name] = relative

    def is_local_module(self, name):
        if not name:
            return False
        if name in self.file_by_module:
            return True
        prefix = name + "."
        return any(module.startswith(prefix) for module in self.file_by_module)

    def resolve_from_module(self, relative, node):
        module = node.module or ""
        if node.level == 0:
            return module
        current = list(self.modules_by_file.get(relative, []))
        if not current:
            return module
        preferred = min(current, key=lambda value: value.count("."))
        parts = preferred.split(".")
        if not relative.endswith("__init__.py"):
            parts = parts[:-1]
        remove = max(0, node.level - 1)
        if remove:
            parts = parts[:-remove]
        if module:
            parts.extend(module.split("."))
        return ".".join(parts)

    def import_is_local(self, relative, node):
        if isinstance(node, ast.Import):
            return all(self.is_local_module(alias.name) for alias in node.names)
        if node.level > 0:
            return self.is_local_module(self.resolve_from_module(relative, node))
        return self.is_local_module(node.module or "")


def sanitized_assignment(node, keep_value=False):
    keep_value = keep_value and not any(is_sensitive_name(name) for name in assignment_names(node))
    if isinstance(node, ast.AnnAssign):
        result = copy.deepcopy(node)
        result.value = copy.deepcopy(node.value) if keep_value else None
        return result
    result = copy.deepcopy(node)
    if hasattr(result, "type_comment"):
        result.type_comment = None
    result.value = copy.deepcopy(node.value) if keep_value else ast.Constant(value=Ellipsis)
    return result


def local_import(repository, relative, node):
    if isinstance(node, ast.Import):
        aliases = [copy.deepcopy(alias) for alias in node.names if repository.is_local_module(alias.name)]
        if not aliases:
            return None
        result = copy.deepcopy(node)
        result.names = aliases
        return result
    return copy.deepcopy(node) if repository.import_is_local(relative, node) else None


def call_summary(entry):
    if not entry:
        return None
    parts = []
    calls = entry.get("callsInSourceOrder", entry["calls"])
    if calls:
        parts.append("Calls: " + ", ".join(calls))
    if entry.get("instantiates"):
        parts.append("Instantiates: " + ", ".join(entry["instantiates"]))
    if entry.get("unresolvedProjectCalls"):
        parts.append("Unresolved project: " + ", ".join(entry["unresolvedProjectCalls"]))
    if entry.get("externalCalls"):
        parts.append("External: " + ", ".join(entry["externalCalls"]))
    return "; ".join(parts) if parts else None


def entry_for(graph, relative, node):
    normalized = relative.replace(os.sep, "/")
    return next((entry for entry in graph.values()
                 if entry["file"] == normalized and entry["line"] == node.lineno), None)


def outline_function(node, graph, relative):
    result = copy.deepcopy(node)
    result.type_comment = None
    all_arguments = list(result.args.posonlyargs) + list(result.args.args) + list(result.args.kwonlyargs)
    if result.args.vararg:
        all_arguments.append(result.args.vararg)
    if result.args.kwarg:
        all_arguments.append(result.args.kwarg)
    for argument in all_arguments:
        argument.type_comment = None
    positional = list(result.args.posonlyargs) + list(result.args.args)
    default_arguments = positional[len(positional) - len(result.args.defaults):]
    for index, argument in enumerate(default_arguments):
        if is_sensitive_name(argument.arg):
            result.args.defaults[index] = ast.Constant(value=Ellipsis)
    for index, argument in enumerate(result.args.kwonlyargs):
        if is_sensitive_name(argument.arg) and result.args.kw_defaults[index] is not None:
            result.args.kw_defaults[index] = ast.Constant(value=Ellipsis)
    summary = call_summary(entry_for(graph, relative, node))
    result.body = ([ast.Expr(value=ast.Constant(value=summary))] if summary else []) + [ast.Pass()]
    return result


def outline_class(node, repository, relative, graph):
    result = copy.deepcopy(node)
    enum_class = any(tail_name(base) in ("Enum", "IntEnum", "StrEnum", "Flag", "IntFlag") for base in node.bases)
    body = []
    for statement in node.body:
        if isinstance(statement, FUNCTION_NODES):
            body.append(outline_function(statement, graph, relative))
        elif isinstance(statement, ast.ClassDef):
            body.append(outline_class(statement, repository, relative, graph))
        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
            body.append(sanitized_assignment(statement, keep_value=enum_class))
        elif isinstance(statement, (ast.Import, ast.ImportFrom)):
            imported = local_import(repository, relative, statement)
            if imported:
                body.append(imported)
    result.body = body or [ast.Pass()]
    return result


def outline_module(repository, relative, graph):
    body = []
    for statement in repository.trees[relative].body:
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            imported = local_import(repository, relative, statement)
            if imported:
                body.append(imported)
        elif isinstance(statement, FUNCTION_NODES):
            body.append(outline_function(statement, graph, relative))
        elif isinstance(statement, ast.ClassDef):
            body.append(outline_class(statement, repository, relative, graph))
        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
            body.append(sanitized_assignment(statement))
        elif isinstance(statement, ast.If) and dotted_name(statement.test) in ("TYPE_CHECKING", "typing.TYPE_CHECKING"):
            imports = [local_import(repository, relative, item) for item in statement.body
                       if isinstance(item, (ast.Import, ast.ImportFrom))]
            imports = [item for item in imports if item]
            if imports:
                copied = copy.deepcopy(statement)
                copied.body = imports
                copied.orelse = []
                body.append(copied)
    module = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module)
    rendered = ast.unparse(module).strip()
    return GENERATED_HEADER + ("\n\n" + rendered + "\n" if rendered else "\n")


class CallableRecord:
    def __init__(self, file_name, node, base_name, owner=None):
        self.file = file_name
        self.node = node
        self.base_name = base_name
        self.owner = owner
        self.id = base_name
        self.kind = "constructor" if owner and node.name == "__init__" else ("method" if owner else "function")


class ClassRecord:
    def __init__(self, file_name, node, base_name):
        self.file = file_name
        self.node = node
        self.base_name = base_name
        self.id = base_name
        self.methods = {}


def collect_symbols(repository):
    callables = []
    classes = []
    for relative in repository.relative_files:
        def visit_statements(statements, prefix="", owner=None):
            for statement in statements:
                if isinstance(statement, ast.ClassDef):
                    base_name = prefix + statement.name
                    class_record = ClassRecord(relative, statement, base_name)
                    classes.append(class_record)
                    for member in statement.body:
                        if isinstance(member, FUNCTION_NODES):
                            if is_overload(member):
                                continue
                            record = CallableRecord(relative, member, base_name + "." + member.name, class_record)
                            callables.append(record)
                            class_record.methods.setdefault(member.name, []).append(record)
                        elif isinstance(member, ast.ClassDef):
                            visit_statements([member], base_name + ".")
                elif isinstance(statement, FUNCTION_NODES):
                    if is_overload(statement):
                        continue
                    base_name = prefix + statement.name
                    record = CallableRecord(relative, statement, base_name, owner)
                    callables.append(record)
                    visit_statements(statement.body, base_name + ".")
        visit_statements(repository.trees[relative].body)

    for record in classes:
        record.id = record.file.replace(os.sep, "/") + "#" + record.base_name
    for record in callables:
        record.id = record.file.replace(os.sep, "/") + "#" + record.base_name
    return sorted(callables, key=lambda item: item.id), sorted(classes, key=lambda item: item.id)


def function_signature(node):
    copied = outline_function(node, {}, "")
    copied.decorator_list = []
    copied.body = [ast.Pass()]
    module = ast.Module(body=[copied], type_ignores=[])
    ast.fix_missing_locations(module)
    header = ast.unparse(module).split("\n", 1)[0]
    prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
    if header.startswith(prefix):
        header = header[len(prefix):]
    return header[:-1] if header.endswith(":") else header


class FileScope:
    def __init__(self):
        self.functions = {}
        self.classes = {}
        self.imported_symbols = {}
        self.imported_modules = {}
        self.external_names = {}


def build_scopes(repository, callables, classes):
    scopes = {relative: FileScope() for relative in repository.relative_files}
    functions_by_file = {}
    classes_by_file = {}
    for record in callables:
        functions_by_file.setdefault(record.file, []).append(record)
        if "." not in record.base_name:
            scopes[record.file].functions.setdefault(record.base_name, []).append(record)
    for record in classes:
        classes_by_file.setdefault(record.file, []).append(record)
        if "." not in record.base_name:
            scopes[record.file].classes.setdefault(record.base_name, []).append(record)

    for relative, tree in repository.trees.items():
        scope = scopes[relative]
        for statement in tree.body:
            if isinstance(statement, ast.Import):
                for alias in statement.names:
                    local = repository.is_local_module(alias.name)
                    local_name = alias.asname or alias.name.split(".", 1)[0]
                    if local:
                        scope.imported_modules[local_name] = alias.name if alias.asname else local_name
                    else:
                        scope.external_names[local_name] = (alias.name, None)
            elif isinstance(statement, ast.ImportFrom):
                module = repository.resolve_from_module(relative, statement)
                local = statement.level > 0 or repository.is_local_module(module)
                for alias in statement.names:
                    local_name = alias.asname or alias.name
                    if local:
                        target = module + "." + alias.name if module else alias.name
                        if repository.is_local_module(target):
                            scope.imported_modules[local_name] = target
                        else:
                            scope.imported_symbols[local_name] = target
                    else:
                        scope.external_names[local_name] = (statement.module or alias.name, alias.name)
    return scopes, functions_by_file, classes_by_file


class CallAnalyzer(ast.NodeVisitor):
    def __init__(self, record, repository, scopes, callables, classes):
        self.record = record
        self.repository = repository
        self.scope = scopes[record.file]
        self.callables = callables
        self.classes = classes
        self.calls = set()
        self.call_sequence = []
        self.constructs = set()
        self.unresolved = set()
        self.external_calls = set()
        self.invoked_parameters = set()
        self.call_sites = []
        self.variable_classes = {}
        for argument in list(record.node.args.posonlyargs) + list(record.node.args.args) + list(record.node.args.kwonlyargs):
            resolved = self.resolve_class_annotation(argument.annotation)
            if len(resolved) == 1:
                self.variable_classes[argument.arg] = next(iter(resolved))

    def resolve_imported_target(self, target):
        module_name, separator, symbol_name = target.rpartition(".")
        if not separator:
            return set(), set()
        files = set()
        direct = self.repository.file_by_module.get(module_name)
        if direct:
            files.add(direct)
        return ({record for record in self.callables if record.file in files and record.base_name == symbol_name},
                {record for record in self.classes if record.file in files and record.base_name == symbol_name})

    def resolve_class_annotation(self, annotation):
        if annotation is None:
            return set()
        if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
            name = annotation.value
        else:
            name = dotted_name(annotation)
        if not name:
            return set()
        return self.resolve_class_name(name)

    def resolve_class_name(self, name):
        if "." not in name:
            local = set(self.scope.classes.get(name, []))
            target = self.scope.imported_symbols.get(name)
            if target:
                local.update(self.resolve_imported_target(target)[1])
            return local
        first, rest = name.split(".", 1)
        module = self.scope.imported_modules.get(first)
        if module:
            return self.resolve_imported_target(module + "." + rest)[1]
        return set()

    def resolve_function_name(self, name):
        if "." not in name:
            local = set(self.scope.functions.get(name, []))
            target = self.scope.imported_symbols.get(name)
            if target:
                local.update(self.resolve_imported_target(target)[0])
            return local
        first, rest = name.split(".", 1)
        module = self.scope.imported_modules.get(first)
        if module:
            return self.resolve_imported_target(module + "." + rest)[0]
        return set()

    def resolve_method(self, expression):
        if not isinstance(expression, ast.Attribute):
            return set()
        owner_classes = set()
        if isinstance(expression.value, ast.Name):
            base = expression.value.id
            if base in ("self", "cls") and self.record.owner:
                owner_classes.add(self.record.owner)
            owner_classes.update(self.variable_classes.get(base, set()) if isinstance(self.variable_classes.get(base), set) else
                                 ({self.variable_classes[base]} if base in self.variable_classes else set()))
            owner_classes.update(self.resolve_class_name(base))
        elif isinstance(expression.value, ast.Call) and dotted_name(expression.value.func) == "super" and self.record.owner:
            for base in self.record.owner.node.bases:
                owner_classes.update(self.resolve_class_name(dotted_name(base) or ""))
        matches = set()
        for owner in owner_classes:
            matches.update(owner.methods.get(expression.attr, []))
        return matches

    def external_target(self, expression):
        name = dotted_name(expression)
        if not name:
            return "" if isinstance(expression, ast.Attribute) and expression.attr in TRIVIAL_LITERAL_METHODS else None
        first, separator, rest = name.partition(".")
        binding = self.scope.external_names.get(first)
        if binding:
            module, imported_name = binding
            api = imported_name or (rest if separator else first)
            if imported_name and separator:
                api += "." + rest
            return module + "#" + api
        if isinstance(expression, ast.Attribute) and expression.attr in TRIVIAL_LITERAL_METHODS:
            return ""
        return "" if first in BUILTIN_NAMES else None

    def visit_Assign(self, node):
        if isinstance(node.value, ast.Call):
            classes = self.resolve_class_name(dotted_name(node.value.func) or "")
            if len(classes) == 1:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        self.variable_classes[target.id] = next(iter(classes))
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name):
            classes = self.resolve_class_annotation(node.annotation)
            if len(classes) == 1:
                self.variable_classes[node.target.id] = next(iter(classes))
        self.generic_visit(node)

    def visit_Call(self, node):
        name = dotted_name(node.func) or ""
        parameter_names = {argument.arg for argument in
                           list(self.record.node.args.posonlyargs) + list(self.record.node.args.args) +
                           list(self.record.node.args.kwonlyargs)}
        if isinstance(node.func, ast.Name) and node.func.id in parameter_names:
            self.invoked_parameters.add(node.func.id)
        classes = self.resolve_class_name(name)
        if len(classes) == 1:
            self.constructs.add(next(iter(classes)).id)
        elif len(classes) > 1:
            self.unresolved.add(ast.unparse(node.func))
        else:
            matches = self.resolve_method(node.func)
            if not matches:
                matches = self.resolve_function_name(name)
            if len(matches) == 1:
                target = next(iter(matches))
                self.calls.add(target.id)
                if target.id not in self.call_sequence:
                    self.call_sequence.append(target.id)
                self.call_sites.append((target, node))
            elif len(matches) > 1:
                self.unresolved.add(ast.unparse(node.func))
            else:
                external = self.external_target(node.func)
                if external:
                    self.external_calls.add(external)
                elif external is None:
                    self.unresolved.add(ast.unparse(node.func))
        for argument in node.args:
            self.visit(argument)
        for keyword in node.keywords:
            self.visit(keyword.value)

    def visit_FunctionDef(self, node):
        if node is self.record.node:
            for statement in node.body:
                self.visit(statement)

    def visit_AsyncFunctionDef(self, node):
        self.visit_FunctionDef(node)


def create_call_graph(repository):
    callables, classes = collect_symbols(repository)
    scopes, _functions_by_file, _classes_by_file = build_scopes(repository, callables, classes)
    graph = {}
    analyzers = {}
    for record in callables:
        analyzer = CallAnalyzer(record, repository, scopes, callables, classes)
        for statement in record.node.body:
            analyzer.visit(statement)
        graph[record.id] = {
            "file": record.file.replace(os.sep, "/"),
            "line": record.node.lineno,
            "column": record.node.col_offset + 1,
            "kind": record.kind,
            "signature": function_signature(record.node),
            "calls": sorted(analyzer.calls),
            "calledBy": [],
        }
        if analyzer.constructs:
            graph[record.id]["instantiates"] = sorted(analyzer.constructs)
        if analyzer.unresolved:
            graph[record.id]["unresolvedProjectCalls"] = sorted(analyzer.unresolved)
        if analyzer.external_calls:
            graph[record.id]["externalCalls"] = sorted(analyzer.external_calls)
        if analyzer.call_sequence != graph[record.id]["calls"]:
            graph[record.id]["callsInSourceOrder"] = analyzer.call_sequence
        analyzers[record.id] = analyzer
    for analyzer in analyzers.values():
        for target, call in analyzer.call_sites:
            target_analyzer = analyzers[target.id]
            parameters = (list(target.node.args.posonlyargs) + list(target.node.args.args) +
                          list(target.node.args.kwonlyargs))
            if target.owner and parameters and parameters[0].arg in ("self", "cls"):
                parameters = parameters[1:]
            parameter_names = [parameter.arg for parameter in parameters]
            keyword_arguments = {keyword.arg: keyword.value for keyword in call.keywords if keyword.arg}
            for invoked in target_analyzer.invoked_parameters:
                if invoked not in parameter_names:
                    continue
                index = parameter_names.index(invoked)
                argument = call.args[index] if index < len(call.args) else keyword_arguments.get(invoked)
                if argument is None:
                    continue
                matches = analyzer.resolve_method(argument)
                if not matches:
                    matches = analyzer.resolve_function_name(dotted_name(argument) or "")
                graph[target.id]["calls"].extend(record.id for record in matches)
                for matched in sorted(matches, key=lambda item: item.id):
                    sequence = graph[target.id].setdefault("callsInSourceOrder", list(target_analyzer.call_sequence))
                    if matched.id not in sequence:
                        sequence.append(matched.id)
            graph[target.id]["calls"] = sorted(set(graph[target.id]["calls"]))
    for entry in graph.values():
        if entry.get("callsInSourceOrder") == entry["calls"]:
            entry.pop("callsInSourceOrder", None)
    for caller, entry in graph.items():
        for callee in entry["calls"]:
            if callee in graph:
                graph[callee]["calledBy"].append(caller)
    for entry in graph.values():
        entry["calledBy"].sort()
    return {key: graph[key] for key in sorted(graph)}


def main():
    if sys.version_info < (3, 9):
        raise RuntimeError("Python 3.9 or newer is required")
    request = json.load(sys.stdin)
    repository = Repository(request["root"], request["files"])
    graph = create_call_graph(repository)
    result = {
        "outlines": {relative: outline_module(repository, relative, graph) for relative in repository.relative_files},
        "callgraph": graph,
    }
    json.dump(result, sys.stdout, sort_keys=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error) + "\n")
        sys.exit(1)
