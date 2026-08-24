import 'package:flutter/material.dart';
import 'package:shared/shared.dart';
import 'profile_screen.dart';
import 'workspace_detail_screen.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  List<dynamic> _workspaces = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadWorkspaces();
  }

  Future<void> _loadWorkspaces() async {
    setState(() => _isLoading = true);
    try {
      final workspaces = await ApiClient.instance.getWorkspaces();
      if (mounted) setState(() => _workspaces = workspaces);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to load workspaces: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _createWorkspace() async {
    final titleController = TextEditingController();
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('New Workspace'),
        content: TextField(
          controller: titleController,
          decoration: const InputDecoration(hintText: 'Workspace title'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Create'),
          ),
        ],
      ),
    );

    if (result == true && titleController.text.isNotEmpty) {
      try {
        await ApiClient.instance.createWorkspace(titleController.text);
        _loadWorkspaces();
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to create workspace: $e')),
          );
        }
      }
    }
  }

  Future<void> _deleteWorkspace(String id) async {
    try {
      await ApiClient.instance.deleteWorkspace(id);
      _loadWorkspaces();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Workspace deleted')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to delete workspace: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Workspaces'),
        actions: [
          IconButton(
            icon: const Icon(Icons.person),
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const ProfileScreen()),
              );
            },
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _workspaces.isEmpty
              ? const Center(child: Text('No workspaces yet. Create one!'))
              : RefreshIndicator(
                  onRefresh: _loadWorkspaces,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _workspaces.length,
                    itemBuilder: (context, index) {
                      final workspace = _workspaces[index];
                      return Card(
                        margin: const EdgeInsets.only(bottom: 12),
                        child: ListTile(
                          leading: const CircleAvatar(
                            child: Icon(Icons.workspaces),
                          ),
                          title: Text(workspace['metadata']['title'] ?? 'Untitled'),
                          subtitle: Text('ID: ${workspace['id']}'),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                icon: const Icon(Icons.delete, color: Colors.red),
                                onPressed: () => _deleteWorkspace(workspace['id']),
                              ),
                              const Icon(Icons.chevron_right),
                            ],
                          ),
                          onTap: () {
                            Navigator.of(context).push(
                              MaterialPageRoute(
                                builder: (_) => WorkspaceDetailScreen(
                                  workspace: workspace,
                                ),
                              ),
                            );
                          },
                        ),
                      );
                    },
                  ),
                ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _createWorkspace,
        icon: const Icon(Icons.add),
        label: const Text('New Workspace'),
      ),
    );
  }
}
