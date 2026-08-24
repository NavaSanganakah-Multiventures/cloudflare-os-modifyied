import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

class ApiClient {
  static const String baseUrl = 'http://10.0.2.2:8787/api/mobile/v1'; // Android Emulator alias for localhost
  String? _token;

  ApiClient._privateConstructor();
  static final ApiClient instance = ApiClient._privateConstructor();

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString('auth_token');
  }

  Future<void> logout() async {
    _token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('auth_token');
  }

  bool get isAuthenticated => _token != null;

  Map<String, String> get _headers {
    return {
      'Content-Type': 'application/json',
      if (_token != null) 'Authorization': 'Bearer $_token',
    };
  }

  Future<void> startGithubLogin() async {
    final response = await http.get(Uri.parse('$baseUrl/auth/github'));
    if (response.statusCode == 200) {
      final data = jsonDecode(response.body);
      final url = Uri.parse(data['url']);
      final pendingId = data['pendingId'];

      if (await canLaunchUrl(url)) {
        await launchUrl(url, mode: LaunchMode.externalApplication);
        await _waitForLogin(pendingId);
      } else {
        throw Exception('Could not launch browser');
      }
    } else {
      throw Exception('Failed to start login');
    }
  }

  Future<void> _waitForLogin(String pendingId) async {
    while (true) {
      try {
        final response = await http.get(Uri.parse('$baseUrl/auth/wait?pendingId=$pendingId'));
        if (response.statusCode == 200) {
          final data = jsonDecode(response.body);
          if (data['token'] != null) {
            _token = data['token'];
            final prefs = await SharedPreferences.getInstance();
            await prefs.setString('auth_token', _token!);
            return;
          }
        }
      } catch (e) {
        // ignore and retry
      }
      await Future.delayed(const Duration(seconds: 2));
    }
  }

  Future<Map<String, dynamic>> whoami() async {
    final response = await http.get(Uri.parse('$baseUrl/whoami'), headers: _headers);
    if (response.statusCode == 200) {
      return jsonDecode(response.body)['info'];
    }
    throw Exception('Failed to fetch profile');
  }

  Future<List<dynamic>> getWorkspaces() async {
    final response = await http.get(Uri.parse('$baseUrl/workspaces'), headers: _headers);
    if (response.statusCode == 200) {
      return jsonDecode(response.body)['workspaces'];
    }
    throw Exception('Failed to fetch workspaces');
  }

  Future<dynamic> createWorkspace(String title) async {
    final response = await http.post(
      Uri.parse('$baseUrl/workspaces'),
      headers: _headers,
      body: jsonEncode({'title': title}),
    );
    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    }
    throw Exception('Failed to create workspace');
  }

  Future<void> deleteWorkspace(String id) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/workspaces?id=$id'),
      headers: _headers,
    );
    if (response.statusCode != 200) {
      throw Exception('Failed to delete workspace');
    }
  }

  Future<List<dynamic>> getGatekeepers() async {
    final response = await http.get(Uri.parse('$baseUrl/gatekeepers'), headers: _headers);
    if (response.statusCode == 200) {
      return jsonDecode(response.body)['vendors'];
    }
    throw Exception('Failed to fetch gatekeepers');
  }
}
