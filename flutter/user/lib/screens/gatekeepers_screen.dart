import 'package:flutter/material.dart';
import 'package:shared/shared.dart';

class GatekeepersScreen extends StatefulWidget {
  const GatekeepersScreen({super.key});

  @override
  State<GatekeepersScreen> createState() => _GatekeepersScreenState();
}

class _GatekeepersScreenState extends State<GatekeepersScreen> {
  List<dynamic> _vendors = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadGatekeepers();
  }

  Future<void> _loadGatekeepers() async {
    try {
      final vendors = await ApiClient.instance.getGatekeepers();
      if (mounted) setState(() => _vendors = vendors);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to load gatekeepers: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Gatekeepers & Resources'),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _vendors.isEmpty
              ? const Center(child: Text('No gatekeepers available'))
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _vendors.length,
                  itemBuilder: (context, index) {
                    final vendor = _vendors[index];
                    return Card(
                      margin: const EdgeInsets.only(bottom: 12),
                      child: ListTile(
                        leading: vendor['icon'] != null 
                            ? Image.network(vendor['icon'], width: 40, height: 40)
                            : const Icon(Icons.api),
                        title: Text(vendor['title'] ?? vendor['id']),
                        subtitle: Text(vendor['description'] ?? ''),
                        trailing: ElevatedButton(
                          onPressed: () {
                            // TODO: Implement Add/Connect Resource
                          },
                          child: const Text('Add'),
                        ),
                      ),
                    );
                  },
                ),
    );
  }
}
